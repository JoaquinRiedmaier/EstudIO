use std::fs;
use std::path::Path;

fn cargar_env(ruta: &Path) {
    if let Ok(contenido) = fs::read_to_string(ruta) {
        println!("cargo:rerun-if-changed={}", ruta.display());
        for linea in contenido.lines() {
            let linea = linea.trim();
            if linea.is_empty() || linea.starts_with('#') {
                continue;
            }
            if let Some((clave, valor)) = linea.split_once('=') {
                let clave = clave.trim();
                let mut valor = valor.trim();
                // Quitar comillas dobles o simples si las contiene
                if (valor.starts_with('"') && valor.ends_with('"'))
                    || (valor.starts_with('\'') && valor.ends_with('\''))
                {
                    if valor.len() >= 2 {
                        valor = &valor[1..valor.len() - 1];
                    }
                }
                // Inyectar para rustc solo si no existe ya en el entorno (ej. en CI)
                if std::env::var(clave).is_err() {
                    println!("cargo:rustc-env={}={}", clave, valor);
                }
            }
        }
    }
}

fn main() {
    // Intentar cargar variables desde .env en la raíz del proyecto o en src-tauri
    cargar_env(Path::new("../.env"));
    cargar_env(Path::new(".env"));

    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-changed=.env");
    println!("cargo:rerun-if-env-changed=ESTUDIO_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=ESTUDIO_GOOGLE_CLIENT_SECRET");

    tauri_build::build()
}
