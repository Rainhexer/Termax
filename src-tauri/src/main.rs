#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // First, before any thread: GUI launches on macOS/Linux inherit a stripped
    // PATH that hides Homebrew's `gh`, among others.
    #[cfg(not(windows))]
    termax_lib::widen_path();
    #[cfg(target_os = "linux")]
    linux_render::configure();
    termax_lib::run();
}

/// How the window gets drawn on Linux.
///
/// WebKitGTK renders the page in a separate process and has two ways of getting
/// the result into the window. With the DMABUF renderer the frame stays on the
/// GPU and is composited there; without it, the frame is copied through shared
/// memory and composited by the CPU. This disables the DMABUF one, which reads
/// like giving up hardware acceleration, and the reason given for it was a crash
/// — webkitgtk's DMABUF path dies with "Error 71 (Protocol error) dispatching to
/// Wayland display" under the proprietary NVIDIA driver. A workaround for one
/// driver, applied to every Linux machine, is the kind of thing that quietly
/// costs a terminal emulator everything, so it was measured.
///
/// It is not costing this one. On an Intel iGPU under Wayland, four panes
/// producing 25 KB/s, same binary, same load, only this variable different:
///
/// | | UI main thread | webview event-loop lateness | IPC round trip |
/// |---|---|---|---|
/// | DMABUF off (this) | 13.4 s / 30 s | 8.0 ms | 23.5 ms |
/// | DMABUF on | 8.9 s / 30 s | 15.5 ms | 38.5 ms |
///
/// It is a trade, not a win: turning it on moves a third of the work off this
/// process's main thread and onto the webview's, and the webview's is the one
/// that parses escape sequences, draws the panes and answers keystrokes. Both
/// latency numbers roughly doubled. For a terminal that is the wrong side of the
/// trade, so it stays off — now on evidence rather than on the crash.
///
/// What did change is that it is no longer *forced*. An explicit setting wins in
/// either direction: a machine where the DMABUF path is better can have it with
/// `WEBKIT_DISABLE_DMABUF_RENDERER=0`, and one that breaks in some way not named
/// here can still be pinned with `=1`. The old unconditional `set_var`
/// overwrote both, which is also what made the table above impossible to
/// produce without recompiling.
#[cfg(target_os = "linux")]
mod linux_render {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    pub fn configure() {
        if std::env::var_os(VAR).is_some() {
            return;
        }
        // Safe here, and only here: this runs as the first statement of `main`,
        // before any thread exists to race the environment.
        std::env::set_var(VAR, "1");
    }
}
