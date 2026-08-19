use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

// Terminal state for every pane, kept here rather than only in the webview.
//
// Why the backend needs its own screen
// ------------------------------------
// The webview has exactly one thread, and xterm parses escape sequences on it.
// That is affordable while the panes producing output are the ones you can see
// — a screenful is a bounded number — and it stops being affordable the moment
// the answer to "how many agents are running" is "a hundred". Their output has
// nothing to draw into: the panes are in other tabs, and xterm has already
// stopped rendering them (its own IntersectionObserver sees the detached
// element). All that is left is the parse, and the parse is the expensive part.
//
// The only reason those bytes were shipped at all is that two features need to
// know what a hidden pane's screen says: the sidebar's activity readout, which
// reads the CLI's own UI text, and the run/bell heuristics, which watch for
// titles, bells and shell-integration markers. Both want *terminal state*, not
// terminal bytes.
//
// So the state is modelled here instead. Every pane gets a screen fed with its
// raw output, whether or not anyone is looking at it, and a hidden pane's bytes
// stop crossing the IPC boundary entirely. The frontend asks for the text it
// needs (a few dozen rows, only for panes whose screen actually changed), and
// gets the pane's real bytes back only when the pane is shown again.
//
// Cost is now bounded by what is on screen, which is what a native terminal
// multiplexer manages and what this app could not.

/// Bytes of a hidden pane's output kept for replay when it is shown again.
///
/// Under this, the pane is handed back its exact byte stream, so its scrollback
/// survives a trip through another tab. Over it, see [`PaneScreen::show`]: the
/// raw stream is abandoned for a repaint of the screen itself, which is
/// accurate and costs a fixed amount however long the pane was away.
const MAX_REPLAY: usize = 1024 * 1024;

/// Something the pane's program did that the frontend would otherwise have
/// found by scanning the raw stream.
///
/// Only produced for hidden panes. A visible pane's bytes still arrive in the
/// webview, where xterm and the existing scanners see them exactly as before —
/// emitting these as well would double every title change and ring every bell
/// twice.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Signal {
    /// OSC 0/2 — coding CLIs put the task they are working on here.
    Title { title: String },
    /// ^G. Rung by shells and TUIs that want attention.
    Bell,
    /// OSC 52, still base64 as the program sent it.
    Clipboard { data: String },
    /// OSC 133;D — a command finished, with its exit code when the shell said.
    CommandDone { code: Option<i32> },
    /// Any OSC 133 at all, which proves the shell is instrumented.
    ShellIntegration,
}

/// Collects [`Signal`]s out of the escape sequences vt100 does not model.
#[derive(Default)]
struct Sink {
    signals: Vec<Signal>,
    /// Suppressed while the pane is visible: the webview is already seeing
    /// these for itself. Kept as a flag on the sink rather than checked by the
    /// caller so a signal is never collected only to be thrown away.
    collect: bool,
}

impl Sink {
    fn push(&mut self, signal: Signal) {
        if self.collect {
            self.signals.push(signal);
        }
    }
}

impl vt100::Callbacks for Sink {
    fn audible_bell(&mut self, _: &mut vt100::Screen) {
        self.push(Signal::Bell);
    }

    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.push(Signal::Title {
            title: String::from_utf8_lossy(title).into_owned(),
        });
    }

    fn copy_to_clipboard(&mut self, _: &mut vt100::Screen, _ty: &[u8], data: &[u8]) {
        self.push(Signal::Clipboard {
            data: String::from_utf8_lossy(data).into_owned(),
        });
    }

    /// Shell integration (OSC 133 "semantic prompts") is not part of the screen
    /// model, so vt100 hands it here. `ESC ] 133 ; D ; <code> BEL` is the only
    /// exit code a terminal can observe for a command typed into an already
    /// running shell.
    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if params.first() != Some(&b"133".as_slice()) {
            return;
        }
        self.push(Signal::ShellIntegration);
        if params.get(1) != Some(&b"D".as_slice()) {
            return;
        }
        // `133;D` with no code means "finished, exit status unknown".
        let code = params
            .get(2)
            .and_then(|raw| std::str::from_utf8(raw).ok())
            .and_then(|text| text.parse().ok());
        self.push(Signal::CommandDone { code });
    }
}

struct PaneScreen {
    parser: vt100::Parser<Sink>,
    /// Raw output produced while hidden, for replay. Empty while visible.
    replay: Vec<u8>,
    /// True once [`MAX_REPLAY`] was passed, so `replay` no longer holds the
    /// whole absence and must not be used as one.
    overflowed: bool,
    visible: bool,
    /// Bumped whenever bytes are processed. The frontend's poller remembers the
    /// value it last saw and skips panes whose screen cannot have changed —
    /// with a hundred mostly-waiting agents, that is nearly all of them.
    seq: u64,
}

impl PaneScreen {
    fn new(rows: u16, cols: u16) -> Self {
        // No scrollback: the only thing read out of here is the live screen —
        // for a full-screen TUI that is the alternate buffer, and for an inline
        // renderer the bottom rows are the live UI. Scrollback would be memory
        // spent on rows nothing asks for, times however many agents are running.
        let parser = vt100::Parser::new_with_callbacks(rows, cols, 0, Sink::default());
        Self {
            parser,
            replay: Vec::new(),
            overflowed: false,
            visible: true,
            seq: 0,
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> Vec<Signal> {
        self.parser.callbacks_mut().collect = !self.visible;
        self.parser.process(bytes);
        self.seq = self.seq.wrapping_add(1);

        if !self.visible {
            if self.replay.len() + bytes.len() > MAX_REPLAY {
                // Past the point where keeping the stream is worth it. Drop it
                // and let `show` repaint from the screen instead — abandoning
                // it wholesale rather than trimming the front, because a stream
                // missing its beginning would replay into a terminal whose
                // state no longer matches it.
                self.overflowed = true;
                self.replay.clear();
            } else {
                self.replay.extend_from_slice(bytes);
            }
        }

        std::mem::take(&mut self.parser.callbacks_mut().signals)
    }

    /// Mark the pane visible and return the bytes that bring its terminal up to
    /// date: the output it missed, or — once that grew past [`MAX_REPLAY`] — a
    /// repaint of the current screen.
    ///
    /// The repaint is self-contained (vt100 writes a clear first), so it is
    /// safe to hand to a terminal that still holds the pane's older content. It
    /// costs the pane's scrollback, which is the trade for a fixed bound on how
    /// much a long absence can cost.
    fn show(&mut self) -> Vec<u8> {
        self.visible = true;
        if self.overflowed {
            self.overflowed = false;
            self.replay.clear();
            return self.parser.screen().contents_formatted();
        }
        std::mem::take(&mut self.replay)
    }

    fn hide(&mut self) {
        self.visible = false;
    }

    /// The last `rows` rows of the live screen, as plain text — the same view
    /// `readPaneTail` reads out of xterm for a pane that is on screen.
    fn tail(&self, rows: u16) -> String {
        let (height, width) = self.parser.screen().size();
        let lines: Vec<String> = self.parser.screen().rows(0, width).collect();
        let start = lines.len().saturating_sub(rows.min(height) as usize);
        lines[start..].join("\n")
    }
}

/// Every pane's screen, keyed the same way the PTYs are.
#[derive(Default)]
pub struct ScreenStore {
    panes: Mutex<HashMap<String, PaneScreen>>,
}

/// What one pane's screen looked like when it was asked for.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneTail {
    pub pane_id: String,
    pub seq: u64,
    pub text: String,
}

/// A pane the frontend wants the screen of, and the version it already holds.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailQuery {
    pub pane_id: String,
    /// The `seq` of the last tail this caller received; a pane still at this
    /// version is left out of the reply entirely.
    pub seq: u64,
}

impl ScreenStore {
    pub fn open(&self, pane_id: String, rows: u16, cols: u16) {
        self.panes
            .lock()
            .unwrap()
            .insert(pane_id, PaneScreen::new(rows.max(1), cols.max(1)));
    }

    pub fn close(&self, pane_id: &str) {
        self.panes.lock().unwrap().remove(pane_id);
    }

    /// Screens currently held, for the diagnostics log.
    pub fn len(&self) -> usize {
        self.panes.lock().unwrap().len()
    }

    pub fn resize(&self, pane_id: &str, rows: u16, cols: u16) {
        if let Some(pane) = self.panes.lock().unwrap().get_mut(pane_id) {
            pane.parser.screen_mut().set_size(rows.max(1), cols.max(1));
        }
    }

    /// Feed a pane its output. Returns whether the webview should be sent these
    /// bytes, and any signals the frontend has to be told about because it will
    /// not be seeing them itself.
    pub fn feed(&self, pane_id: &str, bytes: &[u8]) -> (bool, Vec<Signal>) {
        let mut guard = self.panes.lock().unwrap();
        let Some(pane) = guard.get_mut(pane_id) else {
            // No screen for this pane — it was closed, or spawned before the
            // store knew about it. Forward the bytes rather than swallowing
            // them; the frontend drops what it cannot place.
            return (true, Vec::new());
        };
        let signals = pane.feed(bytes);
        (pane.visible, signals)
    }

    /// Returns replay bytes when a hidden pane becomes visible again.
    pub fn set_visible(&self, pane_id: &str, visible: bool) -> Option<Vec<u8>> {
        let mut guard = self.panes.lock().unwrap();
        let pane = guard.get_mut(pane_id)?;
        if !visible {
            pane.hide();
            return None;
        }
        if pane.visible {
            return None;
        }
        let replay = pane.show();
        (!replay.is_empty()).then_some(replay)
    }

    /// Screens for the panes that changed since the caller last asked.
    pub fn tails(&self, queries: &[TailQuery], rows: u16) -> Vec<PaneTail> {
        let guard = self.panes.lock().unwrap();
        queries
            .iter()
            .filter_map(|query| {
                let pane = guard.get(&query.pane_id)?;
                // Unchanged: the screen it would read is the one it has.
                if pane.seq == query.seq {
                    return None;
                }
                Some(PaneTail {
                    pane_id: query.pane_id.clone(),
                    seq: pane.seq,
                    text: pane.tail(rows),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane() -> PaneScreen {
        PaneScreen::new(4, 20)
    }

    #[test]
    fn the_tail_reads_the_live_screen() {
        let mut pane = pane();
        pane.feed(b"one\r\ntwo\r\nthree\r\n");
        assert_eq!(pane.tail(2), "three\n");
        assert!(pane.tail(4).contains("one"));
    }

    /// The whole point of the store: a hidden pane's bytes are held, not sent.
    #[test]
    fn a_hidden_pane_keeps_its_bytes_for_replay() {
        let mut pane = pane();
        pane.hide();
        pane.feed(b"while you were out");
        assert_eq!(pane.show(), b"while you were out");
        // Replayed once, not twice.
        pane.hide();
        assert_eq!(pane.show(), b"");
    }

    /// A long absence must cost a fixed amount, so past the cap the stream is
    /// abandoned for a repaint of the screen it produced.
    #[test]
    fn a_long_absence_is_replayed_as_a_repaint() {
        let mut pane = pane();
        pane.hide();
        pane.feed(&vec![b'x'; MAX_REPLAY + 1]);
        pane.feed(b"\r\nlast line");
        let replay = pane.show();
        assert!(replay.len() < MAX_REPLAY, "replay should be bounded");
        let text = String::from_utf8_lossy(&replay);
        assert!(text.contains("last line"), "screen repaint should carry the screen");
        // Self-contained: it clears before painting, so it is safe to write
        // into a terminal that still holds the pane's older content.
        assert!(replay.starts_with(b"\x1b["), "repaint should begin with escapes");
    }

    #[test]
    fn a_visible_pane_buffers_nothing() {
        let mut pane = pane();
        pane.feed(b"seen live");
        assert!(pane.replay.is_empty());
        assert_eq!(pane.show(), b"");
    }

    /// Signals exist so a hidden pane can still ring a bell and report its
    /// task. A visible pane's are suppressed: the webview sees those itself,
    /// and emitting them too would double every title and ring twice.
    #[test]
    fn signals_are_only_collected_for_hidden_panes() {
        let mut pane = pane();
        assert_eq!(pane.feed(b"\x1b]0;working\x07\x07"), vec![]);
        pane.hide();
        assert_eq!(
            pane.feed(b"\x1b]0;working\x07\x07"),
            vec![
                Signal::Title {
                    title: "working".into()
                },
                Signal::Bell,
            ]
        );
    }

    #[test]
    fn shell_integration_markers_carry_the_exit_code() {
        let mut pane = pane();
        pane.hide();
        assert_eq!(
            pane.feed(b"\x1b]133;D;3\x07"),
            vec![
                Signal::ShellIntegration,
                Signal::CommandDone { code: Some(3) }
            ]
        );
        // A bare D marker means finished with an unknown status.
        assert_eq!(
            pane.feed(b"\x1b]133;D\x07"),
            vec![Signal::ShellIntegration, Signal::CommandDone { code: None }]
        );
        // A prompt marker proves instrumentation but ends nothing.
        assert_eq!(pane.feed(b"\x1b]133;A\x07"), vec![Signal::ShellIntegration]);
    }

    #[test]
    fn clipboard_requests_survive_being_hidden() {
        let mut pane = pane();
        pane.hide();
        assert_eq!(
            pane.feed(b"\x1b]52;c;aGVsbG8=\x07"),
            vec![Signal::Clipboard {
                data: "aGVsbG8=".into()
            }]
        );
    }

    /// An escape sequence split across two reads must still be understood, or a
    /// hidden pane's title and markers would be missed at random.
    #[test]
    fn a_sequence_split_across_reads_is_still_seen() {
        let mut pane = pane();
        pane.hide();
        assert_eq!(pane.feed(b"\x1b]0;half"), vec![]);
        assert_eq!(
            pane.feed(b" a title\x07"),
            vec![Signal::Title {
                title: "half a title".into()
            }]
        );
    }

    #[test]
    fn the_store_skips_panes_that_have_not_drawn() {
        let store = ScreenStore::default();
        store.open("p".into(), 4, 20);
        store.feed("p", b"hello");
        let first = store.tails(
            &[TailQuery {
                pane_id: "p".into(),
                seq: 0,
            }],
            4,
        );
        assert_eq!(first.len(), 1);
        assert!(first[0].text.contains("hello"));

        // Asking again at the version just received returns nothing at all.
        let again = store.tails(
            &[TailQuery {
                pane_id: "p".into(),
                seq: first[0].seq,
            }],
            4,
        );
        assert!(again.is_empty());
    }

    #[test]
    fn output_for_an_unknown_pane_is_forwarded_rather_than_swallowed() {
        let store = ScreenStore::default();
        let (send, signals) = store.feed("never-opened", b"hi");
        assert!(send);
        assert!(signals.is_empty());
    }
}
