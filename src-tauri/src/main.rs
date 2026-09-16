#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Solución al bug de WebKitGTK en Linux (Wayland / Mesa / Nvidia / Intel)
        // que congela el viewport del WebView al tamaño inicial dejando áreas negras al maximizar/tiling.
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    estudio_lib::run();
}

