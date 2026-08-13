use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

// How PTY output reaches the webview, and why it looks like this
// ---------------------------------------------------------------
// Two costs shape this file, and both are paid on the window's event loop — the
// same loop that dispatches key presses, which is why they show up as typing
// lag rather than as slow output.
//
// The first is the *number* of hand-offs. Every one of them queues work on that
// loop, and one per PTY read is fine for a shell and ruinous for a dozen busy
// coding agents: a redrawing TUI produces hundreds of small reads a second
// each. So every pane's output funnels into one coalescing thread that hands
// over at most one batch per `FLUSH_INTERVAL`, carrying every pane's bytes at
// once. The rate is then bounded by the clock instead of by how many agents are
// running.
//
// The second is the *shape* of each hand-off. A Tauri event is delivered by
// building a snippet of JavaScript and evaluating it on the webview, with the
// payload inlined as a JSON literal — so every ESC byte becomes the six
// characters ``, and an escape-dense TUI frame is inflated and then
// parsed as fresh source. A channel carrying a raw body avoids that entirely:
// Tauri routes anything over about a kilobyte through the `ipc:` protocol as
// binary, leaving only a fixed-size eval to start the transfer. Small payloads
// (an echoed keystroke) still go direct, which is what keeps echo latency where
// it was.

/// Longest a pane's output waits to be handed to the webview. Short enough that
/// echoed keystrokes still feel immediate, long enough to fold a burst of small
/// reads into a single batch.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Flush early once a batch reaches this size, so a `cat` of something huge is
/// handed over in digestible pieces rather than one enormous buffer.
const MAX_BATCH_BYTES: usize = 256 * 1024;

/// Ceiling on the output buffered for one pane between flushes. With flow
/// control in place this is only reachable while the webview is not draining at
/// all (no stream attached yet, or a reload in flight); dropping the oldest
/// bytes keeps a runaway process from growing this without bound.
const MAX_PANE_PENDING: usize = 4 * 1024 * 1024;

const READ_BUF: usize = 64 * 1024;

// Flow control
// ------------
// Without it, a pane that outruns the webview simply had its oldest bytes
// dropped — which loses output *and* desynchronizes the terminal's escape-
// sequence state, since the dropped span can end mid-sequence.
//
// A native terminal does not do this. It stops reading, the pty's buffer fills,
// and the program's own `write` blocks until the terminal catches up. That is
// what the watermark below reproduces: the reader thread parks while the pane
// has more than this many bytes handed over but not yet drawn, and the agent
// throttles itself.
const HIGH_WATERMARK: u64 = 1024 * 1024;

/// How long a parked reader waits before re-checking its pane's debt.
const FLOW_POLL: Duration = Duration::from_millis(500);

/// Consecutive `FLOW_POLL` waits with no acknowledgement at all before the debt
/// is written off and the pane resumes. A wedged or torn-down webview must not
/// be able to freeze a running agent indefinitely; ten seconds of total silence
/// is well past any legitimate backlog.
const STALL_LIMIT: u32 = 20;

/// Bytes handed to the webview but not yet reported as drawn, per pane.
#[derive(Default)]
struct Flow {
    unacked: Mutex<HashMap<String, u64>>,
    /// Signalled whenever an acknowledgement lands, so parked readers re-check.
    drained: Condvar,
}

impl Flow {
    fn owe(&self, pane_id: &str, bytes: u64) {
        let mut guard = self.unacked.lock().unwrap();
        *guard.entry(pane_id.to_string()).or_insert(0) += bytes;
    }

    fn ack(&self, pane_id: &str, bytes: u64) {
        let mut guard = self.unacked.lock().unwrap();
        if let Some(debt) = guard.get_mut(pane_id) {
            *debt = debt.saturating_sub(bytes);
            if *debt == 0 {
                guard.remove(pane_id);
            }
        }
        self.drained.notify_all();
    }

    fn forget(&self, pane_id: &str) {
        self.unacked.lock().unwrap().remove(pane_id);
        self.drained.notify_all();
    }

    /// Forget every pane's debt. Used when a stream is (re)attached: the webview
    /// that owed the acknowledgements is gone, so waiting for them would park
    /// every reader forever.
    fn reset(&self) {
        self.unacked.lock().unwrap().clear();
        self.drained.notify_all();
    }

    /// Park until this pane is under the watermark. Returns false once the pane
    /// is closed, so its reader can stop.
    fn wait_for_room(&self, pane_id: &str) {
        let mut guard = self.unacked.lock().unwrap();
        let mut stalled = 0;
        while guard.get(pane_id).copied().unwrap_or(0) >= HIGH_WATERMARK {
            let (next, timeout) = self.drained.wait_timeout(guard, FLOW_POLL).unwrap();
            guard = next;
            if timeout.timed_out() {
                stalled += 1;
                if stalled >= STALL_LIMIT {
                    guard.remove(pane_id);
                    return;
                }
            } else {
                stalled = 0;
            }
        }
    }
}

struct PtyHandle {
    /// Behind its own lock, so a resize or a foreground-group check on one pane
    /// cannot stall input to another.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Keystrokes go to a per-pane writer thread rather than being written
    /// inline: a write to a pty whose reader has stopped blocks, and the caller
    /// here is the thread that also runs the UI.
    input: Sender<Vec<u8>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Pid of the program spawned into the pty (the shell). It is its own
    /// process group leader, so the tty's foreground pgid equals this exactly
    /// when the shell itself is in front — i.e. no command is running.
    shell_pid: Option<u32>,
}

/// Where a batch of output is written, once the frontend has attached one.
///
/// Absent before `attach_pty_stream` and replaced on every reattach (a window
/// reload rebuilds it), so this is a slot rather than a `OnceLock`.
type Sink = Arc<Mutex<Option<Channel<InvokeResponseBody>>>>;

#[derive(Default)]
pub struct PtyManager {
    ptys: Mutex<HashMap<String, Arc<PtyHandle>>>,
    /// Created with the first pane, so an app that never opens a terminal never
    /// starts the coalescing thread.
    signals: OnceLock<Sender<Signal>>,
    sink: Sink,
    flow: Arc<Flow>,
}

/// What a pane's reader thread reports to the coalescer.
enum Signal {
    Output { pane_id: String, bytes: Vec<u8> },
    Exit { pane_id: String },
}

/// One pane's drained-byte report; see [`Flow`].
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneAck {
    pane_id: String,
    bytes: u64,
}

/// Wire format version, so a frontend and backend that disagree fail loudly at
/// the first batch instead of mis-slicing one.
const FRAME_VERSION: u8 = 1;

const RECORD_OUTPUT: u8 = 0;
const RECORD_EXIT: u8 = 1;

/// One thing that happened to one pane, in the order it happened.
///
/// Exits travel in the same frame as output rather than as a separate Tauri
/// event, and that is not tidiness: the two transports have different latencies
/// (a large batch goes through the `ipc:` protocol, an event through an eval),
/// so an exit sent alongside would routinely overtake the output that preceded
/// it. The pane would then be torn down — and the last lines the command
/// printed dropped — before they were ever drawn.
#[derive(Debug, PartialEq)]
enum Record {
    /// Decoded output — see [`decode_utf8`].
    Output { pane_id: String, data: String },
    Exit { pane_id: String },
}

/// Serialize one batch: a version byte, then a length-prefixed record each.
///
/// Length-prefixed rather than delimited because the payload is arbitrary
/// terminal output — there is no byte that cannot appear in it.
///
///   `[u8 version] ( [u8 kind][u16 id_len][id] [u32 data_len][data]? )*`
fn encode_batch(records: &[Record]) -> Vec<u8> {
    let size = 1 + records
        .iter()
        .map(|record| match record {
            Record::Output { pane_id, data } => 7 + pane_id.len() + data.len(),
            Record::Exit { pane_id } => 3 + pane_id.len(),
        })
        .sum::<usize>();
    let mut out = Vec::with_capacity(size);
    out.push(FRAME_VERSION);
    for record in records {
        let (kind, pane_id, data) = match record {
            Record::Output { pane_id, data } => (RECORD_OUTPUT, pane_id, Some(data)),
            Record::Exit { pane_id } => (RECORD_EXIT, pane_id, None),
        };
        out.push(kind);
        out.extend_from_slice(&(pane_id.len() as u16).to_le_bytes());
        out.extend_from_slice(pane_id.as_bytes());
        if let Some(data) = data {
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(data.as_bytes());
        }
    }
    out
}

/// Decode PTY bytes as UTF-8, carrying a trailing incomplete sequence over to
/// the next batch.
///
/// Decoding here rather than in the frontend is what lets the payload be a
/// plain JSON string instead of base64: it drops an encode on this side and an
/// `atob` plus a byte-by-byte copy on the other. It also fixes a real defect —
/// the frontend built a fresh `TextDecoder` per chunk, so a multi-byte
/// character straddling two PTY reads was decoded by neither half and came out
/// as replacement characters.
///
/// Invalid bytes (a program writing latin-1) become U+FFFD, matching what
/// `TextDecoder` did with them.
fn decode_utf8(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    let joined: Vec<u8>;
    let mut rest: &[u8] = if carry.is_empty() {
        bytes
    } else {
        joined = carry.drain(..).chain(bytes.iter().copied()).collect();
        &joined
    };

    let mut out = String::with_capacity(rest.len());
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or_default());
                }
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        rest = &rest[valid + n..];
                    }
                    // Truncated at the end of the read. At most three bytes, so
                    // the carry cannot grow: hold them for the next batch.
                    None => {
                        carry.extend_from_slice(&rest[valid..]);
                        break;
                    }
                }
            }
        }
    }
    out
}

/// Output accumulated since the last flush, keyed by pane.
#[derive(Default)]
struct Pending {
    /// Panes in order of first arrival in this batch, so the emitted array is
    /// deterministic and a pane's own chunks stay in sequence.
    order: Vec<String>,
    data: HashMap<String, Vec<u8>>,
    carries: HashMap<String, Vec<u8>>,
    bytes: usize,
}

impl Pending {
    fn accept(&mut self, signal: Signal, exits: &mut Vec<String>) {
        let (pane_id, bytes) = match signal {
            Signal::Exit { pane_id } => {
                exits.push(pane_id);
                return;
            }
            Signal::Output { pane_id, bytes } => (pane_id, bytes),
        };

        if !self.data.contains_key(&pane_id) {
            self.order.push(pane_id.clone());
            self.data.insert(pane_id.clone(), Vec::new());
        }
        let buf = self.data.get_mut(&pane_id).expect("just inserted");
        buf.extend_from_slice(&bytes);
        self.bytes += bytes.len();
        if buf.len() > MAX_PANE_PENDING {
            let overflow = buf.len() - MAX_PANE_PENDING;
            buf.drain(..overflow);
            self.bytes -= overflow;
        }
    }

    /// Hand this window's output — and any exits that ended it — to the webview
    /// as one frame. Exits go last so they never overtake a pane's own output.
    fn flush(&mut self, sink: &Sink, flow: &Flow, exits: Vec<String>) {
        self.bytes = 0;
        let mut records = Vec::with_capacity(self.order.len() + exits.len());
        for pane_id in self.order.drain(..) {
            let Some(bytes) = self.data.remove(&pane_id) else {
                continue;
            };
            let carry = self.carries.entry(pane_id.clone()).or_default();
            let data = decode_utf8(carry, &bytes);
            // Everything went to the carry: nothing to show yet.
            if data.is_empty() {
                continue;
            }
            records.push(Record::Output { pane_id, data });
        }
        for pane_id in exits {
            self.carries.remove(&pane_id);
            flow.forget(&pane_id);
            records.push(Record::Exit { pane_id });
        }
        if records.is_empty() {
            return;
        }

        // Nothing is listening yet (startup, or a reload between teardown and
        // reattach). Dropping is right: holding the batch would only park every
        // reader behind a webview that may never come back, and the pane has
        // not been drawn into yet either.
        let guard = sink.lock().unwrap();
        let Some(channel) = guard.as_ref() else {
            return;
        };

        // The debt is counted here, over exactly the bytes the frontend will
        // acknowledge, so the two counters cannot drift.
        for record in &records {
            if let Record::Output { pane_id, data } = record {
                flow.owe(pane_id, data.len() as u64);
            }
        }
        let payload = encode_batch(&records);
        if channel.send(InvokeResponseBody::Raw(payload)).is_err() {
            // The webview went away mid-send; release what we just charged for
            // rather than parking the readers on an acknowledgement that will
            // never arrive.
            drop(guard);
            for record in &records {
                if let Record::Output { pane_id, .. } = record {
                    flow.forget(pane_id);
                }
            }
        }
    }
}

/// Fold every pane's output into one batch per [`FLUSH_INTERVAL`].
fn run_coalescer(rx: Receiver<Signal>, sink: Sink, flow: Arc<Flow>) {
    let mut pending = Pending::default();
    loop {
        // Blocks while every pane is quiet, so an idle app does no work at all.
        let Ok(first) = rx.recv() else { break };
        let deadline = Instant::now() + FLUSH_INTERVAL;
        let mut exits = Vec::new();
        pending.accept(first, &mut exits);

        // An exit cuts the window short: it travels in the frame it arrived
        // with, behind that frame's output, so the pane is not torn down before
        // its last lines have been drawn.
        while exits.is_empty() && pending.bytes < MAX_BATCH_BYTES {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(signal) => pending.accept(signal, &mut exits),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    pending.flush(&sink, &flow, exits);
                    return;
                }
            }
        }

        pending.flush(&sink, &flow, exits);
    }
    pending.flush(&sink, &flow, Vec::new());
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

impl PtyManager {
    fn signals(&self) -> Sender<Signal> {
        self.signals
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel();
                let sink = Arc::clone(&self.sink);
                let flow = Arc::clone(&self.flow);
                std::thread::spawn(move || run_coalescer(rx, sink, flow));
                tx
            })
            .clone()
    }

    /// Point output at a freshly built frontend stream.
    ///
    /// Any debt recorded against the previous one is written off: the webview
    /// that owed those acknowledgements no longer exists, and leaving them
    /// outstanding would park the readers of every pane that survived a reload.
    fn attach_stream(&self, channel: Channel<InvokeResponseBody>) {
        self.flow.reset();
        *self.sink.lock().unwrap() = Some(channel);
    }

    fn handle(&self, pane_id: &str) -> Option<Arc<PtyHandle>> {
        self.ptys.lock().unwrap().get(pane_id).cloned()
    }

    pub fn spawn(
        &self,
        pane_id: String,
        cwd: String,
        command: Option<String>,
        rows: u16,
        cols: u16,
        shell_override: Option<String>,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = shell_override.unwrap_or_else(default_shell);
        let mut cmd = match &command {
            Some(c) if !c.trim().is_empty() => {
                let mut cmd = CommandBuilder::new(&shell);
                #[cfg(windows)]
                cmd.args(["/C", c]);
                #[cfg(not(windows))]
                cmd.args(["-ilc", c]);
                cmd
            }
            _ => CommandBuilder::new(&shell),
        };
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let signals = self.signals();
        let reader_pane = pane_id.clone();
        let reader_flow = Arc::clone(&self.flow);
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                // Before reading more, wait until the webview has caught up on
                // what this pane already produced. Parking here is the whole
                // mechanism: it stops draining the pty, so the program's own
                // writes block and it slows to the speed we can draw at.
                reader_flow.wait_for_room(&reader_pane);
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let sent = signals.send(Signal::Output {
                            pane_id: reader_pane.clone(),
                            bytes: buf[..n].to_vec(),
                        });
                        if sent.is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = signals.send(Signal::Exit {
                pane_id: reader_pane,
            });
        });

        let (input, input_rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(mut data) = input_rx.recv() {
                // Fold a burst (a paste arrives as many small messages) into one
                // write so the pty sees it as a single chunk.
                while let Ok(more) = input_rx.try_recv() {
                    data.extend_from_slice(&more);
                }
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        let shell_pid = child.process_id();
        self.ptys.lock().unwrap().insert(
            pane_id,
            Arc::new(PtyHandle {
                master: Mutex::new(pair.master),
                input,
                child: Mutex::new(child),
                shell_pid,
            }),
        );
        Ok(())
    }

    /// Whether a foreground command is running in the pane, from the tty's
    /// foreground process group. `None` when it cannot be determined (Windows,
    /// no such pane, or the pty does not expose the pgid), so callers can fall
    /// back to their own heuristics.
    ///
    /// This is what makes long silent commands (a crate compiling for minutes)
    /// distinguishable from a finished one without shell integration.
    pub fn foreground_busy(&self, pane_id: &str) -> Option<bool> {
        #[cfg(unix)]
        {
            let handle = self.handle(pane_id)?;
            let shell_pid = handle.shell_pid?;
            let fg = handle.master.lock().unwrap().process_group_leader()?;
            if fg <= 0 {
                return None;
            }
            Some(fg as u32 != shell_pid)
        }
        #[cfg(not(unix))]
        {
            let _ = pane_id;
            None
        }
    }

    /// Queue input for the pane. Returns once the bytes are handed to the
    /// pane's writer thread, without waiting for the pty to accept them.
    pub fn write(&self, pane_id: &str, data: &str) -> Result<(), String> {
        let handle = self.handle(pane_id).ok_or("no such pane")?;
        handle
            .input
            .send(data.as_bytes().to_vec())
            .map_err(|_| "pane is closed".to_string())
    }

    pub fn resize(&self, pane_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let handle = self.handle(pane_id).ok_or("no such pane")?;
        let master = handle.master.lock().unwrap();
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, pane_id: &str) {
        let handle = self.ptys.lock().unwrap().remove(pane_id);
        if let Some(handle) = handle {
            let _ = handle.child.lock().unwrap().kill();
        }
        // A closed pane will never be drawn again, so nothing will acknowledge
        // its outstanding bytes; releasing them lets its reader thread wake and
        // notice the pty is gone instead of parking until the stall guard.
        self.flow.forget(pane_id);
    }

    pub fn kill_all(&self) {
        let handles: Vec<Arc<PtyHandle>> = self.ptys.lock().unwrap().drain().map(|(_, h)| h).collect();
        for handle in handles {
            let _ = handle.child.lock().unwrap().kill();
        }
        self.flow.reset();
    }

    /// Record that the webview has drawn these bytes, freeing the readers of
    /// any pane that was parked on the watermark.
    pub fn ack(&self, acks: &[PaneAck]) {
        for ack in acks {
            self.flow.ack(&ack.pane_id, ack.bytes);
        }
    }
}

// Every command below is `async` so it runs on the async runtime rather than on
// the window's event loop, which is where a plain `#[tauri::command]` body runs.
// `write_pty` is the exception: keystrokes must reach the pty in the order they
// were typed, and only the synchronous path preserves the order the IPC
// delivered them in. It is safe there because the write itself is now a channel
// send that never blocks.

/// Hand the frontend's output stream to the coalescer.
///
/// Called once as the terminal layer initializes, and again after any reload
/// that rebuilds it. Panes spawned before this lose their earliest output
/// rather than stalling behind a webview that is not listening yet — see the
/// note in `Pending::flush`.
#[tauri::command(async)]
pub fn attach_pty_stream(
    manager: tauri::State<PtyManager>,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    manager.attach_stream(channel);
    Ok(())
}

/// Report bytes the webview has finished drawing, per pane.
///
/// Deliberately *not* `async`: this releases readers parked on the watermark,
/// so it must not queue behind whatever else the async runtime is doing.
#[tauri::command]
pub fn ack_pty_output(manager: tauri::State<PtyManager>, acks: Vec<PaneAck>) {
    manager.ack(&acks);
}

#[tauri::command(async)]
pub fn spawn_pty(
    manager: tauri::State<PtyManager>,
    settings: tauri::State<crate::settings::SettingsStore>,
    pane_id: String,
    cwd: String,
    command: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let shell_override = settings.shell_override();
    manager.spawn(pane_id, cwd, command, rows, cols, shell_override)
}

#[tauri::command]
pub fn write_pty(
    manager: tauri::State<PtyManager>,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&pane_id, &data)
}

#[tauri::command(async)]
pub fn resize_pty(
    manager: tauri::State<PtyManager>,
    pane_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(&pane_id, rows, cols)
}

#[tauri::command(async)]
pub fn kill_pty(manager: tauri::State<PtyManager>, pane_id: String) -> Result<(), String> {
    manager.kill(&pane_id);
    Ok(())
}

#[tauri::command(async)]
pub fn pty_foreground_busy(
    manager: tauri::State<PtyManager>,
    pane_id: String,
) -> Result<Option<bool>, String> {
    Ok(manager.foreground_busy(&pane_id))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_utf8, encode_batch, Flow, Record, FRAME_VERSION, HIGH_WATERMARK, RECORD_OUTPUT,
    };
    use std::sync::Arc;

    fn output(pane_id: &str, data: &str) -> Record {
        Record::Output {
            pane_id: pane_id.into(),
            data: data.into(),
        }
    }

    /// Read a batch back the way the frontend does, so the two stay honest
    /// about the layout. Mirrors `readBatch` in src/lib/terminals.ts.
    fn decode_batch(buf: &[u8]) -> Vec<Record> {
        assert_eq!(buf[0], FRAME_VERSION);
        let mut at = 1;
        let mut out = Vec::new();
        while at < buf.len() {
            let kind = buf[at];
            at += 1;
            let id_len = u16::from_le_bytes([buf[at], buf[at + 1]]) as usize;
            at += 2;
            let pane_id = String::from_utf8(buf[at..at + id_len].to_vec()).unwrap();
            at += id_len;
            if kind != RECORD_OUTPUT {
                out.push(Record::Exit { pane_id });
                continue;
            }
            let data_len =
                u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]) as usize;
            at += 4;
            let data = String::from_utf8(buf[at..at + data_len].to_vec()).unwrap();
            at += data_len;
            out.push(Record::Output { pane_id, data });
        }
        out
    }

    #[test]
    fn a_batch_round_trips() {
        let records = vec![
            output("pane-a", "hello"),
            output("pane-b", "\x1b[2J✽ done"),
        ];
        assert_eq!(decode_batch(&encode_batch(&records)), records);
    }

    /// Exits ride in the frame rather than on a separate transport precisely so
    /// they cannot overtake output, so the encoding has to carry both kinds.
    #[test]
    fn a_batch_carries_exits_after_the_output_they_follow() {
        let records = vec![
            output("pane-a", "the last line\r\n"),
            Record::Exit {
                pane_id: "pane-a".into(),
            },
        ];
        assert_eq!(decode_batch(&encode_batch(&records)), records);
    }

    /// The length prefixes exist because output is arbitrary bytes: a payload
    /// that happens to contain NUL, a newline, or something shaped like the
    /// frame header must not be able to end a record early.
    #[test]
    fn payloads_cannot_forge_a_frame_boundary() {
        let records = vec![
            output("p", "\0\u{1}\u{6}\n\x1b]0;x\x07"),
            output("q", "still here"),
        ];
        assert_eq!(decode_batch(&encode_batch(&records)), records);
    }

    #[test]
    fn an_empty_batch_is_just_the_version() {
        assert_eq!(encode_batch(&[]), vec![FRAME_VERSION]);
    }

    #[test]
    fn acknowledgements_clear_the_debt() {
        let flow = Flow::default();
        flow.owe("pane", 100);
        flow.ack("pane", 40);
        assert_eq!(flow.unacked.lock().unwrap().get("pane"), Some(&60));
        // Over-acknowledging (a pane re-attached mid-flight) must not underflow.
        flow.ack("pane", 999);
        assert!(flow.unacked.lock().unwrap().is_empty());
    }

    /// The point of the watermark: a reader under it proceeds without waiting.
    #[test]
    fn a_pane_under_the_watermark_does_not_park() {
        let flow = Flow::default();
        flow.owe("pane", HIGH_WATERMARK - 1);
        flow.wait_for_room("pane");
    }

    #[test]
    fn an_acknowledgement_wakes_a_parked_reader() {
        let flow = Arc::new(Flow::default());
        flow.owe("pane", HIGH_WATERMARK * 2);
        let reader = {
            let flow = Arc::clone(&flow);
            std::thread::spawn(move || flow.wait_for_room("pane"))
        };
        // Give the reader time to actually park before the debt is cleared, so
        // this exercises the wake-up rather than racing past it.
        std::thread::sleep(std::time::Duration::from_millis(50));
        flow.ack("pane", HIGH_WATERMARK * 2);
        reader.join().expect("reader should resume once acked");
    }

    #[test]
    fn closing_a_pane_releases_its_reader() {
        let flow = Arc::new(Flow::default());
        flow.owe("pane", HIGH_WATERMARK * 2);
        let reader = {
            let flow = Arc::clone(&flow);
            std::thread::spawn(move || flow.wait_for_room("pane"))
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        flow.forget("pane");
        reader.join().expect("a killed pane must not park forever");
    }

    #[test]
    fn passes_ascii_through() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8(&mut carry, b"hello"), "hello");
        assert!(carry.is_empty());
    }

    #[test]
    fn reassembles_a_character_split_across_reads() {
        // A pty read can end anywhere, including the middle of "…".
        let ellipsis = "…".as_bytes();
        let (head, tail) = ellipsis.split_at(1);
        let mut carry = Vec::new();
        assert_eq!(decode_utf8(&mut carry, head), "");
        assert_eq!(carry.len(), 1);
        assert_eq!(decode_utf8(&mut carry, tail), "…");
        assert!(carry.is_empty());
    }

    #[test]
    fn keeps_text_around_a_split_character() {
        let mut carry = Vec::new();
        let mut first = b"ok ".to_vec();
        first.extend_from_slice(&"✽".as_bytes()[..2]);
        assert_eq!(decode_utf8(&mut carry, &first), "ok ");
        let mut second = "✽".as_bytes()[2..].to_vec();
        second.extend_from_slice(b" done");
        assert_eq!(decode_utf8(&mut carry, &second), "✽ done");
    }

    #[test]
    fn replaces_invalid_bytes_and_continues() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8(&mut carry, b"a\xffb"), "a\u{FFFD}b");
        assert!(carry.is_empty());
    }

    #[test]
    fn carry_cannot_grow_past_one_sequence() {
        let mut carry = Vec::new();
        for _ in 0..100 {
            decode_utf8(&mut carry, &[0xF0]);
        }
        assert!(carry.len() <= 4, "carry grew to {}", carry.len());
    }
}
