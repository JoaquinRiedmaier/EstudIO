use serde::{Deserialize, Serialize};
use tauri::Manager;
use keyring::Entry;

const SERVICE_NAME: &str = "com.chicharito.estudio";
const KEY_USER: &str = "groq_api_key";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroqConfig {
    pub api_key: String,
    pub modelo: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroqMetadata {
    pub modelo: String,
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

/// Guarda la API Key de Groq de forma segura en el llavero/Keyring del sistema operativo
/// y almacena únicamente la configuración del modelo en disco.
#[tauri::command]
pub fn guardar_groq_config(config: GroqConfig, app: tauri::AppHandle) -> Result<(), String> {
    // 1. Guardar API Key en el Keyring del SO (Secret Service / KWallet en Linux, Credential Manager en Windows, Keychain en macOS)
    let entry = Entry::new(SERVICE_NAME, KEY_USER)
        .map_err(|e| format!("Error inicializando Keyring del sistema: {}", e))?;

    entry
        .set_password(&config.api_key)
        .map_err(|e| format!("Error guardando clave en el Keyring del sistema operativo: {}", e))?;

    // 2. Guardar únicamente metadatos no sensibles (modelo elegido) en disco
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("groq_config.json");

    let metadata = GroqMetadata {
        modelo: config.modelo,
    };
    let json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;

    eprintln!("[audio_config] API Key guardada de forma segura en el Keyring del sistema operativo.");
    Ok(())
}

/// Recupera la API Key de Groq desde el Keyring del sistema operativo y los metadatos de configuración.
#[tauri::command]
pub fn obtener_groq_config(app: tauri::AppHandle) -> Result<Option<GroqConfig>, String> {
    // 1. Obtener metadatos del modelo desde disco
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let path = dir.join("groq_config.json");

    let modelo = if path.exists() {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if let Ok(meta) = serde_json::from_str::<GroqMetadata>(&content) {
            meta.modelo
        } else if let Ok(legacy) = serde_json::from_str::<GroqConfig>(&content) {
            // Migración automática de formato legacy en texto plano a Keyring
            if !legacy.api_key.is_empty() {
                if let Ok(entry) = Entry::new(SERVICE_NAME, KEY_USER) {
                    let _ = entry.set_password(&legacy.api_key);
                }
            }
            legacy.modelo
        } else {
            "whisper-large-v3-turbo".to_string()
        }
    } else {
        "whisper-large-v3-turbo".to_string()
    };

    // 2. Obtener API Key de forma segura desde el Keyring
    let entry = match Entry::new(SERVICE_NAME, KEY_USER) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[audio_config] Advertencia: No se pudo abrir Keyring: {}", e);
            return Ok(None);
        }
    };

    match entry.get_password() {
        Ok(api_key) => {
            if api_key.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(GroqConfig { api_key, modelo }))
            }
        }
        Err(keyring::Error::NoEntry) => {
            // Aún no hay clave guardada
            Ok(None)
        }
        Err(e) => {
            eprintln!("[audio_config] Error consultando Keyring: {}", e);
            Ok(None)
        }
    }
}