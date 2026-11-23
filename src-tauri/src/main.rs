#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // =========================================================================
        // Variables de entorno de WebKitGTK para Linux (rendimiento / viewport).
        //
        // PRUEBAS EN CURSO (problema de fluidez en pantalla completa / scroll touchpad):
        //   - DMABUF activado (0): WebKitGTK comparte frames con la GPU -> más fluido.
        //   - DMABUF desactivado (1): frames por CPU -> se traba en fullscreen/resoluciones altas.
        //   - GDK_BACKEND=x11: evita viewport negro en algunos combos Wayland/Mesa.
        //
        // Estado actual de PRUEBA: DMABUF activado (0) + GDK_BACKEND=x11 por defecto.
        //
        // PARA VOLVER AL ESTADO ANTERIOR (estable previo), cambiar:
        //   WEBKIT_DISABLE_DMABUF_RENDERER -> "1"   (desactivar DMABUF)
        //   y quitar/condicionar el bloque de GDK_BACKEND (dejar Wayland por defecto).
        // =========================================================================

        // DMABUF: por defecto ACTIVADO (0) para probar fluidez. Respetar override del usuario.
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "0");
        }

        // GDK_BACKEND: por defecto x11 (evita viewport negro). Respetar override del usuario.
        // Para probar Wayland, lanzar con GDK_BACKEND=wayland.
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
        }

        // Configuración de rutas de GStreamer para AppImage / entornos empaquetados en Linux.
        // WebKitGTK utiliza GStreamer para getUserMedia (captura de micrófono) y reproducción multimedia.
        // Dentro de AppImage (o en distros como Arch/CachyOS/Fedora/Debian/Ubuntu),
        // es fundamental asegurar que GStreamer encuentre los plugins del sistema host y de la AppImage.
        let mut gst_paths: Vec<std::path::PathBuf> = Vec::new();

        if let Ok(appdir) = std::env::var("APPDIR") {
            let appdir_path = std::path::Path::new(&appdir);
            let candidates = [
                appdir_path.join("usr/lib/gstreamer-1.0"),
                appdir_path.join("usr/lib/x86_64-linux-gnu/gstreamer-1.0"),
                appdir_path.join("usr/lib64/gstreamer-1.0"),
            ];
            for c in candidates {
                if c.is_dir() {
                    gst_paths.push(c);
                }
            }
        }

        let system_candidates = [
            "/usr/lib/gstreamer-1.0",
            "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
            "/usr/lib64/gstreamer-1.0",
            "/usr/local/lib/gstreamer-1.0",
            "/app/lib/gstreamer-1.0",
        ];

        for s in system_candidates {
            let path = std::path::Path::new(s);
            if path.is_dir() && !gst_paths.contains(&path.to_path_buf()) {
                gst_paths.push(path.to_path_buf());
            }
        }

        if !gst_paths.is_empty() {
            let paths_str = gst_paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(":");

            // Actualizar GST_PLUGIN_SYSTEM_PATH_1_0
            if let Ok(curr) = std::env::var("GST_PLUGIN_SYSTEM_PATH_1_0") {
                if !curr.is_empty() {
                    std::env::set_var(
                        "GST_PLUGIN_SYSTEM_PATH_1_0",
                        format!("{}:{}", curr, paths_str),
                    );
                } else {
                    std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &paths_str);
                }
            } else {
                std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &paths_str);
            }

            // Actualizar GST_PLUGIN_PATH_1_0
            if let Ok(curr) = std::env::var("GST_PLUGIN_PATH_1_0") {
                if !curr.is_empty() {
                    std::env::set_var("GST_PLUGIN_PATH_1_0", format!("{}:{}", curr, paths_str));
                } else {
                    std::env::set_var("GST_PLUGIN_PATH_1_0", &paths_str);
                }
            } else {
                std::env::set_var("GST_PLUGIN_PATH_1_0", &paths_str);
            }

            // Actualizar GST_PLUGIN_PATH (legacy)
            if let Ok(curr) = std::env::var("GST_PLUGIN_PATH") {
                if !curr.is_empty() {
                    std::env::set_var("GST_PLUGIN_PATH", format!("{}:{}", curr, paths_str));
                } else {
                    std::env::set_var("GST_PLUGIN_PATH", &paths_str);
                }
            } else {
                std::env::set_var("GST_PLUGIN_PATH", &paths_str);
            }
        }
    }

    estudio_lib::run();
}
