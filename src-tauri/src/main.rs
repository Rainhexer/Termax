#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // webkitgtk's DMABUF renderer crashes on Wayland with NVIDIA drivers
    // ("Error 71 (Protocol error) dispatching to Wayland display").
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    termax_lib::run();
}
