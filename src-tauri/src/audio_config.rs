use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const SERVICE_NAME: &str = "com.chicharito.estudio";
const KEY_USER: &str = "groq_api_key";
const MODELO_POR_DEFECTO: &str = "whisper-large-v3-turbo";
/// Fijar el idioma evita que Whisper lo autodetecte mal en audio ruidoso y devuelva el
/// texto en otro idioma (el caso típico: frases sueltas en inglés sobre grabaciones flojas).
const IDIOMA_POR_DEFECTO: &str = "es";

/// Configuración completa: solo circula dentro del backend.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroqConfig {
    pub api_key: String,
    pub modelo: String,
    /// Código ISO-639-1 del idioma del audio; vacío = que Whisper lo detecte.
    #[serde(default)]
    pub idioma: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct GroqMetadata {
    modelo: String,
    #[serde(default = "idioma_por_defecto")]
    idioma: String,
}

fn idioma_por_defecto() -> String {
    IDIOMA_POR_DEFECTO.to_string()
}

/// Vista que se expone al frontend. Nunca incluye la clave en claro: el webview solo necesita
/// saber si hay una configurada y cómo mostrarla enmascarada.
#[derive(Debug, Serialize, Clone)]
pub struct GroqConfigPublico {
    pub configurado: bool,
    pub modelo: String,
    pub idioma: String,
    pub clave_enmascarada: Option<String>,
}

/// Deja visibles los primeros y últimos cuatro caracteres, lo justo para que el usuario
/// reconozca cuál de sus claves tiene cargada.
fn enmascarar(clave: &str) -> String {
    let caracteres: Vec<char> = clave.chars().collect();
    if caracteres.len() <= 8 {
        return "•".repeat(caracteres.len().max(4));
    }
    let inicio: String = caracteres[..4].iter().collect();
    let fin: String = caracteres[caracteres.len() - 4..].iter().collect();
    format!("{}••••••••{}", inicio, fin)
}

fn ruta_metadata(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("groq_config.json"))
}

fn escribir_metadata(app: &tauri::AppHandle, modelo: &str, idioma: &str) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&GroqMetadata {
        modelo: modelo.to_string(),
        idioma: idioma.to_string(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(ruta_metadata(app)?, json).map_err(|e| e.to_string())
}

/// Modelo e idioma guardados, con valores por defecto si el archivo no existe o no se entiende.
fn leer_metadata(app: &tauri::AppHandle) -> (String, String) {
    let por_defecto = || (MODELO_POR_DEFECTO.to_string(), IDIOMA_POR_DEFECTO.to_string());

    let Ok(path) = ruta_metadata(app) else {
        return por_defecto();
    };
    if !path.exists() {
        return por_defecto();
    }
    let Ok(contenido) = std::fs::read_to_string(&path) else {
        return por_defecto();
    };

    if let Ok(meta) = serde_json::from_str::<GroqMetadata>(&contenido) {
        return (meta.modelo, meta.idioma);
    }

    // Migración automática del formato antiguo, que guardaba la clave en texto plano en disco.
    if let Ok(legacy) = serde_json::from_str::<GroqConfig>(&contenido) {
        if !legacy.api_key.is_empty() {
            if let Ok(entry) = Entry::new(SERVICE_NAME, KEY_USER) {
                let _ = entry.set_password(&legacy.api_key);
            }
        }
        let idioma = if legacy.idioma.is_empty() {
            IDIOMA_POR_DEFECTO.to_string()
        } else {
            legacy.idioma
        };
        let _ = escribir_metadata(app, &legacy.modelo, &idioma);
        return (legacy.modelo, idioma);
    }

    por_defecto()
}

/// Lectura interna de la configuración completa, con la clave incluida.
///
/// Deliberadamente **no** es un comando de Tauri: la clave nunca debe cruzar el puente IPC.
pub fn leer_groq_config(app: &tauri::AppHandle) -> Result<Option<GroqConfig>, String> {
    let (modelo, idioma) = leer_metadata(app);

    let entry = match Entry::new(SERVICE_NAME, KEY_USER) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[audio_config] Advertencia: no se pudo abrir el Keyring: {}", e);
            return Ok(None);
        }
    };

    match entry.get_password() {
        Ok(api_key) if !api_key.trim().is_empty() => {
            Ok(Some(GroqConfig { api_key, modelo, idioma }))
        }
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            eprintln!("[audio_config] Error consultando el Keyring: {}", e);
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn validar_groq_api_key(api_key: String) -> Result<bool, String> {
    let client = reqwest::Client::new();
    let res = client
        .get("https://api.groq.com/openai/v1/models")
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.status().is_success())
}

/// Guarda la API Key en el llavero del sistema operativo (Secret Service en Linux, Credential
/// Manager en Windows, Keychain en macOS) y deja en disco únicamente el modelo elegido.
#[tauri::command]
pub fn guardar_groq_config(config: GroqConfig, app: tauri::AppHandle) -> Result<(), String> {
    let api_key = config.api_key.trim();

    if api_key.is_empty() {
        return Err("La API Key no puede estar vacía.".to_string());
    }
    // La UI muestra la clave enmascarada; si llega de vuelta tal cual, el usuario no escribió
    // una nueva y guardarla dejaría el llavero con un valor inservible.
    if api_key.contains('•') {
        return Err("Escribí de nuevo tu API Key: la que está en pantalla está enmascarada.".to_string());
    }

    let entry = Entry::new(SERVICE_NAME, KEY_USER)
        .map_err(|e| format!("Error inicializando el Keyring del sistema: {}", e))?;

    entry.set_password(api_key).map_err(|e| {
        format!(
            "No se pudo guardar la clave en el llavero del sistema operativo: {}. \
             En Linux hace falta un servicio de secretos activo (gnome-keyring, KWallet o KeePassXC).",
            e
        )
    })?;

    escribir_metadata(&app, &config.modelo, &config.idioma)?;

    eprintln!("[audio_config] API Key guardada en el llavero del sistema operativo.");
    Ok(())
}

/// Actualiza modelo e idioma, sin tocar la clave ya almacenada.
#[tauri::command]
pub fn guardar_groq_modelo(
    modelo: String,
    idioma: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    escribir_metadata(&app, &modelo, &idioma)
}

/// Estado de la configuración para la pantalla de ajustes.
#[tauri::command]
pub fn obtener_groq_config(app: tauri::AppHandle) -> Result<GroqConfigPublico, String> {
    let (modelo, idioma) = leer_metadata(&app);

    let clave_enmascarada = leer_groq_config(&app)?
        .map(|config| enmascarar(&config.api_key));

    Ok(GroqConfigPublico {
        configurado: clave_enmascarada.is_some(),
        modelo,
        idioma,
        clave_enmascarada,
    })
}
