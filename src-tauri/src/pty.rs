use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// Why PTY output is batched before it crosses the IPC boundary
// -------------------------------------------------------------
// A Tauri event is delivered by building a snippet of JavaScript and running it
// on the webview (`Webview::eval`), which queues a task on the window's event
// loop — the same loop that dispatches key presses. Emitting is non-blocking on
// this side, so a reader thread can queue evals far faster than the webview
// drains them, and the backlog is paid for by every keystroke behind it.
//
// One event per PTY read is fine for one shell and ruinous for a dozen busy
// coding agents: a redrawing TUI produces hundreds of small reads a second
// each. So every pane's output funnels into one coalescing thread that emits at
// most one event per `FLUSH_INTERVAL`, carrying every pane's bytes at once. The
// event rate is then bounded by the clock instead of by how many agents are
// running.

/// Longest a pane's output waits to be handed to the webview. Short enough that
/// echoed keystrokes still feel immediate, long enough to fold a burst of small
/// reads into a single event.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);

/// Flush early once a batch reaches this size, so a `cat` of something huge is
/// handed over in digestible pieces rather than one enormous string.
const MAX_BATCH_BYTES: usize = 256 * 1024;

/// Ceiling on the output buffered for one pane between flushes. Only reachable
/// if the webview stops draining entirely; dropping the oldest bytes keeps a
/// runaway process from growing this without bound. The pane's scrollback would
/// have discarded them anyway.
const MAX_PANE_PENDING: usize = 4 * 1024 * 1024;

const READ_BUF: usize = 64 * 1024;

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

#[derive(Default)]
pub struct PtyManager {
    ptys: Mutex<HashMap<String, Arc<PtyHandle>>>,
    /// Created with the first pane, so an app that never opens a terminal never
    /// starts the coalescing thread.
    signals: OnceLock<Sender<Signal>>,
}

/// What a pane's reader thread reports to the coalescer.
enum Signal {
    Output { pane_id: String, bytes: Vec<u8> },
    Exit { pane_id: String },
}

#[derive(Clone, Serialize)]
struct PtyChunk {
    pane_id: String,
    /// Already decoded text — see [`decode_utf8`].
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit<'a> {
    pane_id: &'a str,
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

    fn flush(&mut self, app: &AppHandle) {
        self.bytes = 0;
        if self.order.is_empty() {
            return;
        }
        let mut chunks = Vec::with_capacity(self.order.len());
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
            chunks.push(PtyChunk { pane_id, data });
        }
        if chunks.is_empty() {
            return;
        }
        let _ = app.emit("pty-output", chunks);
    }
}

/// Fold every pane's output into one event per [`FLUSH_INTERVAL`].
fn run_coalescer(app: AppHandle, rx: Receiver<Signal>) {
    let mut pending = Pending::default();
    loop {
        // Blocks while every pane is quiet, so an idle app does no work at all.
        let Ok(first) = rx.recv() else { break };
        let deadline = Instant::now() + FLUSH_INTERVAL;
        let mut exits = Vec::new();
        pending.accept(first, &mut exits);

        // An exit must not overtake the output that preceded it, so it cuts the
        // window short and is emitted after the batch it arrived with.
        while exits.is_empty() && pending.bytes < MAX_BATCH_BYTES {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(signal) => pending.accept(signal, &mut exits),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    pending.flush(&app);
                    return;
                }
            }
        }

        pending.flush(&app);
        for pane_id in exits {
            pending.carries.remove(&pane_id);
            let _ = app.emit("pty-exit", PtyExit { pane_id: &pane_id });
        }
    }
    pending.flush(&app);
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
    fn signals(&self, app: &AppHandle) -> Sender<Signal> {
        self.signals
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel();
                let app = app.clone();
                std::thread::spawn(move || run_coalescer(app, rx));
                tx
            })
            .clone()
    }

    fn handle(&self, pane_id: &str) -> Option<Arc<PtyHandle>> {
        self.ptys.lock().unwrap().get(pane_id).cloned()
    }

    pub fn spawn(
        &self,
        app: AppHandle,
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

        let signals = self.signals(&app);
        let reader_pane = pane_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
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
    }

    pub fn kill_all(&self) {
        let handles: Vec<Arc<PtyHandle>> = self.ptys.lock().unwrap().drain().map(|(_, h)| h).collect();
        for handle in handles {
            let _ = handle.child.lock().unwrap().kill();
        }
    }
}

// Every command below is `async` so it runs on the async runtime rather than on
// the window's event loop, which is where a plain `#[tauri::command]` body runs.
// `write_pty` is the exception: keystrokes must reach the pty in the order they
// were typed, and only the synchronous path preserves the order the IPC
// delivered them in. It is safe there because the write itself is now a channel
// send that never blocks.

#[tauri::command(async)]
pub fn spawn_pty(
    app: AppHandle,
    manager: tauri::State<PtyManager>,
    settings: tauri::State<crate::settings::SettingsStore>,
    pane_id: String,
    cwd: String,
    command: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let shell_override = settings.shell_override();
    manager.spawn(app, pane_id, cwd, command, rows, cols, shell_override)
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
    use super::decode_utf8;

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
