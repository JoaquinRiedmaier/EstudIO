use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use super::DbState;
use crate::estructuras::Apunte;

fn url_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len() * 2);
    for byte in input.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

const DEFAULT_DRIVE_FOLDER_QUERY: &str = "name contains '_export.zip' and trashed = false";

fn leer_variable_env(clave: &str) -> Option<String> {
    // 1. Variable de entorno del sistema
    if let Ok(val) = std::env::var(clave) {
        if !val.trim().is_empty() {
            return Some(val.trim().to_string());
        }
    }
    // 2. Archivos .env (en runtime)
    for ruta in &[".env", "../.env"] {
        if let Ok(contenido) = fs::read_to_string(ruta) {
            for linea in contenido.lines() {
                let linea = linea.trim();
                if linea.is_empty() || linea.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = linea.split_once('=') {
                    if k.trim() == clave {
                        let mut v = v.trim();
                        if (v.starts_with('"') && v.ends_with('"'))
                            || (v.starts_with('\'') && v.ends_with('\''))
                        {
                            if v.len() >= 2 {
                                v = &v[1..v.len() - 1];
                            }
                        }
                        if !v.trim().is_empty() {
                            return Some(v.trim().to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Credenciales por defecto de EstudIO.
/// Se resuelven en el siguiente orden:
/// 1. En tiempo de compilación (inyectadas por build.rs desde .env o en CI desde GitHub Secrets)
/// 2. Variables de entorno del sistema
/// 3. Archivo .env local
pub fn default_client_id() -> String {
    if let Some(val) = option_env!("ESTUDIO_GOOGLE_CLIENT_ID") {
        if !val.is_empty() {
            return val.to_string();
        }
    }
    leer_variable_env("ESTUDIO_GOOGLE_CLIENT_ID").unwrap_or_default()
}

pub fn default_client_secret() -> String {
    if let Some(val) = option_env!("ESTUDIO_GOOGLE_CLIENT_SECRET") {
        if !val.is_empty() {
            return val.to_string();
        }
    }
    leer_variable_env("ESTUDIO_GOOGLE_CLIENT_SECRET").unwrap_or_default()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GoogleTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64, // Unix timestamp in seconds
    pub email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GoogleDriveConfig {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GoogleDriveStatus {
    pub conectado: bool,
    pub email: Option<String>,
    pub mensaje: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DriveFileItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub modified_time: String,
    pub size: Option<u64>,
}

// Retorna la ruta al archivo de tokens en el directorio local de datos de la app
fn get_tokens_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error obteniendo directorio local: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("google_drive_tokens.json"))
}

// Retorna la ruta al archivo de configuración en el directorio local de datos de la app
fn get_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error obteniendo directorio local: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("google_drive_config.json"))
}

// Carga la configuración guardada (Client ID y Client Secret).
// Prioriza las credenciales oficiales de EstudIO (.env / CI secrets).
pub fn cargar_config(app: &AppHandle) -> GoogleDriveConfig {
    let def_id = default_client_id();
    let def_secret = default_client_secret();

    if !def_id.is_empty() {
        return GoogleDriveConfig {
            client_id: def_id,
            client_secret: def_secret,
        };
    }

    if let Ok(path) = get_config_path(app) {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str::<GoogleDriveConfig>(&content) {
                    if !config.client_id.is_empty() {
                        return config;
                    }
                }
            }
        }
    }

    GoogleDriveConfig::default()
}

#[tauri::command]
pub fn guardar_config_google(
    app: AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    let path = get_config_path(&app)?;
    let config = GoogleDriveConfig {
        client_id: client_id.trim().to_string(),
        client_secret: client_secret.trim().to_string(),
    };
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn obtener_config_google(app: AppHandle) -> Result<GoogleDriveConfig, String> {
    Ok(cargar_config(&app))
}

// Carga los tokens almacenados
fn cargar_tokens(app: &AppHandle) -> Option<GoogleTokens> {
    let path = get_tokens_path(app).ok()?;
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

// Guarda los tokens en disco
fn guardar_tokens(app: &AppHandle, tokens: &GoogleTokens) -> Result<(), String> {
    let path = get_tokens_path(app)?;
    let json = serde_json::to_string_pretty(tokens).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Abre una URL en el navegador predeterminado del sistema operativo
fn abrir_url_en_navegador(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// Verifica el estado de vinculación actual
#[tauri::command]
pub async fn obtener_estado_google(app: AppHandle) -> Result<GoogleDriveStatus, String> {
    if let Some(tokens) = cargar_tokens(&app) {
        if tokens.refresh_token.is_some() || tokens.expires_at > Utc::now().timestamp() {
            return Ok(GoogleDriveStatus {
                conectado: true,
                email: tokens.email,
                mensaje: Some("Conectado con Google Drive".to_string()),
            });
        }
    }
    Ok(GoogleDriveStatus {
        conectado: false,
        email: None,
        mensaje: Some("No vinculado".to_string()),
    })
}

/// Desvincula la cuenta de Google Drive borrando los tokens almacenados
#[tauri::command]
pub fn desconectar_google(app: AppHandle) -> Result<(), String> {
    if let Ok(path) = get_tokens_path(&app) {
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

/// Inicia el flujo OAuth 2.0 Loopback en el navegador
#[tauri::command]
pub async fn iniciar_sesion_google(
    app: AppHandle,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<GoogleDriveStatus, String> {
    let mut config = cargar_config(&app);
    if let Some(id) = client_id {
        if !id.trim().is_empty() {
            config.client_id = id.trim().to_string();
        }
    }
    if let Some(secret) = client_secret {
        if !secret.trim().is_empty() {
            config.client_secret = secret.trim().to_string();
        }
    }

    if config.client_id.is_empty() {
        return Err(
            "Debes configurar un Google Client ID en los Ajustes para conectar con Google Drive."
                .to_string(),
        );
    }

    // 1. Iniciar listener TCP local en un puerto efímero asignado por el sistema
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("No se pudo iniciar el listener local: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    // 2. Construir URL de autorización (usando drive.file, el estándar seguro recomendado por Google)
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        url_encode(&config.client_id),
        url_encode(&redirect_uri),
        url_encode("https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email")
    );

    // 3. Abrir en el navegador predeterminado
    abrir_url_en_navegador(&auth_url);

    // 4. Esperar el código en el listener
    let (mut stream, _) = listener
        .accept()
        .map_err(|e| format!("Error esperando autorización en el navegador: {}", e))?;

    let mut reader = BufReader::new(&mut stream);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| e.to_string())?;

    // Parsear el código de: GET /callback?code=XXXXX HTTP/1.1
    let auth_code = if let Some(pos) = request_line.find("code=") {
        let after_code = &request_line[pos + 5..];
        let end_pos = after_code.find(['&', ' ']).unwrap_or(after_code.len());
        after_code[..end_pos].to_string()
    } else {
        // Enviar respuesta de error al navegador
        let response = "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h3>No se recibió el código de autorización de Google.</h3>";
        let _ = stream.write_all(response.as_bytes());
        return Err(
            "No se encontró el código de autorización en la respuesta de Google".to_string(),
        );
    };

    // Responder al navegador con HTML estilizado de confirmación
    let response_html = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>EstudIO - Conectado</title></head><body style='font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:60px;background:#18181b;color:#f4f4f5;'><h2>¡Conectado exitosamente con Google Drive!</h2><p style='color:#a1a1aa;'>Ya puedes cerrar esta pestaña y volver a EstudIO.</p><script>setTimeout(function(){ window.close(); }, 1800);</script></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response_html.len(),
        response_html
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    // 5. Intercambiar auth_code por tokens
    let client = reqwest::Client::new();
    let mut params = vec![
        ("client_id", config.client_id.clone()),
        ("code", auth_code),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri),
    ];
    if !config.client_secret.is_empty() {
        params.push(("client_secret", config.client_secret.clone()));
    }

    let token_res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Error contactando el servidor de tokens de Google: {}", e))?;

    if !token_res.status().is_success() {
        let err_text = token_res.text().await.unwrap_or_default();
        return Err(format!("Error en el intercambio de tokens: {}", err_text));
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: i64,
    }

    let token_data: TokenResponse = token_res
        .json()
        .await
        .map_err(|e| format!("Error parseando tokens: {}", e))?;

    let expires_at = Utc::now().timestamp() + token_data.expires_in;

    // 6. Obtener email del usuario
    let email = match client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(&token_data.access_token)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            #[derive(Deserialize)]
            struct UserInfo {
                email: Option<String>,
            }
            res.json::<UserInfo>().await.ok().and_then(|u| u.email)
        }
        _ => None,
    };

    let tokens = GoogleTokens {
        access_token: token_data.access_token,
        refresh_token: token_data.refresh_token,
        expires_at,
        email: email.clone(),
    };

    guardar_tokens(&app, &tokens)?;
    let _ = guardar_config_google(app, config.client_id, config.client_secret);

    Ok(GoogleDriveStatus {
        conectado: true,
        email,
        mensaje: Some("Google Drive conectado correctamente".to_string()),
    })
}

/// Obtiene un access_token válido, refrescándolo automáticamente si expiró
pub async fn obtener_access_token_valido(app: &AppHandle) -> Result<String, String> {
    let mut tokens = cargar_tokens(app)
        .ok_or_else(|| "No hay ninguna cuenta de Google Drive vinculada".to_string())?;

    let ahora = Utc::now().timestamp();
    if tokens.expires_at > ahora + 90 {
        return Ok(tokens.access_token);
    }

    let refresh_token = tokens
        .refresh_token
        .as_ref()
        .ok_or_else(|| "El token expiró y no se cuenta con refresh_token. Por favor vuelve a vincular tu cuenta.".to_string())?;

    let config = cargar_config(app);
    if config.client_id.is_empty() {
        return Err("No se encontró el Client ID para refrescar la sesión".to_string());
    }

    let client = reqwest::Client::new();
    let mut params = vec![
        ("client_id", config.client_id),
        ("refresh_token", refresh_token.clone()),
        ("grant_type", "refresh_token".to_string()),
    ];
    if !config.client_secret.is_empty() {
        params.push(("client_secret", config.client_secret));
    }

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Error refrescando el token: {}", e))?;

    if !res.status().is_success() {
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Fallo al renovar sesión de Google: {}", err_body));
    }

    #[derive(Deserialize)]
    struct RefreshResponse {
        access_token: String,
        expires_in: i64,
    }

    let data: RefreshResponse = res
        .json()
        .await
        .map_err(|e| format!("Error procesando respuesta de refresco: {}", e))?;

    tokens.access_token = data.access_token.clone();
    tokens.expires_at = Utc::now().timestamp() + data.expires_in;
    guardar_tokens(app, &tokens)?;

    Ok(data.access_token)
}

/// Lista los archivos ZIP de apuntes guardados en Google Drive
#[tauri::command]
pub async fn listar_apuntes_drive(app: AppHandle) -> Result<Vec<DriveFileItem>, String> {
    let token = obtener_access_token_valido(&app).await?;
    let client = reqwest::Client::new();

    let query = url_encode(DEFAULT_DRIVE_FOLDER_QUERY);
    let url = format!(
        "https://www.googleapis.com/drive/v3/files?q={}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime%20desc",
        query
    );

    let res = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Error consultando Google Drive: {}", e))?;

    if !res.status().is_success() {
        let err_msg = res.text().await.unwrap_or_default();
        return Err(format!("Error listando archivos de Drive: {}", err_msg));
    }

    #[derive(Deserialize)]
    struct DriveListResponse {
        files: Option<Vec<DriveFileRaw>>,
    }

    #[derive(Deserialize)]
    struct DriveFileRaw {
        id: String,
        name: String,
        #[serde(rename = "modifiedTime")]
        modified_time: Option<String>,
        size: Option<String>,
    }

    let list_res: DriveListResponse = res
        .json()
        .await
        .map_err(|e| format!("Error parseando lista de archivos de Drive: {}", e))?;

    let items = list_res
        .files
        .unwrap_or_default()
        .into_iter()
        .map(|f| DriveFileItem {
            id: f.id,
            name: f.name,
            modified_time: f.modified_time.unwrap_or_default(),
            size: f.size.and_then(|s| s.parse::<u64>().ok()),
        })
        .collect();

    Ok(items)
}

/// Sube un apunte a Google Drive empaquetándolo primero como ZIP con sus imágenes
#[tauri::command]
pub async fn subir_apunte_drive(app: AppHandle, path_apunte: String) -> Result<String, String> {
    let token = obtener_access_token_valido(&app).await?;
    let client = reqwest::Client::new();

    // 1. Crear el ZIP localmente con la función existente de EstudIO
    let nombre_zip = super::crear_zip(path_apunte.clone())?;
    let directorio = Path::new(&path_apunte)
        .parent()
        .ok_or_else(|| "No se pudo obtener el directorio del apunte".to_string())?;
    let zip_path = directorio.join(&nombre_zip);

    if !zip_path.exists() {
        return Err(format!("No se encontró el ZIP generado en {:?}", zip_path));
    }

    let zip_bytes = fs::read(&zip_path).map_err(|e| format!("Error leyendo el ZIP: {}", e))?;

    // 2. Buscar si ya existen archivos con el mismo nombre en Drive y eliminarlos
    // Esto asegura que siempre haya exactamente UN SOLO zip por cada apunte sincronizado
    let escaped_name = nombre_zip.replace('\'', "\\'");
    let search_q = format!("name = '{}' and trashed = false", escaped_name);
    let search_url = format!(
        "https://www.googleapis.com/drive/v3/files?q={}&fields=files(id,name)",
        url_encode(&search_q)
    );

    let search_res = client
        .get(&search_url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // Eliminar versiones anteriores si las hay
    if search_res.status().is_success() {
        #[derive(Deserialize)]
        struct SearchItem {
            id: String,
        }
        #[derive(Deserialize)]
        struct SearchResponse {
            files: Option<Vec<SearchItem>>,
        }

        if let Ok(body) = search_res.text().await {
            if let Ok(data) = serde_json::from_str::<SearchResponse>(&body) {
                for file in data.files.unwrap_or_default() {
                    let delete_url =
                        format!("https://www.googleapis.com/drive/v3/files/{}", file.id);
                    let _ = client.delete(&delete_url).bearer_auth(&token).send().await;
                }
            }
        }
    }

    // 3. Subir el nuevo archivo limpio a Drive con multipart
    let metadata = serde_json::json!({
        "name": nombre_zip,
        "mimeType": "application/zip"
    });

    let form = Form::new()
        .part(
            "metadata",
            Part::text(metadata.to_string())
                .mime_str("application/json; charset=UTF-8")
                .map_err(|e| e.to_string())?,
        )
        .part(
            "file",
            Part::bytes(zip_bytes)
                .mime_str("application/zip")
                .map_err(|e| e.to_string())?,
        );

    let upload_result = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await;

    // 4. Limpiar el ZIP temporal local
    let _ = fs::remove_file(&zip_path);

    let response = upload_result.map_err(|e| format!("Error en la subida a Drive: {}", e))?;
    if !response.status().is_success() {
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!("Fallo en la subida a Google Drive: {}", err_body));
    }

    Ok(format!(
        "Apunte '{}' sincronizado exitosamente en Google Drive",
        nombre_zip
    ))
}

/// Descarga un ZIP desde Google Drive y lo importa como apunte local con extraer_zip
#[tauri::command]
pub async fn descargar_apunte_drive(
    app: AppHandle,
    file_id: String,
    materia_codigo: String,
    ruta_destino: String,
    state: State<'_, DbState>,
) -> Result<Apunte, String> {
    let token = obtener_access_token_valido(&app).await?;
    let client = reqwest::Client::new();

    // 1. Obtener metadatos del archivo en Drive (nombre)
    let meta_url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?fields=name",
        file_id
    );
    let meta_res = client
        .get(&meta_url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    #[derive(Deserialize)]
    struct FileMeta {
        name: Option<String>,
    }

    let file_name = if meta_res.status().is_success() {
        meta_res
            .json::<FileMeta>()
            .await
            .ok()
            .and_then(|m| m.name)
            .unwrap_or_else(|| "apunte_export.zip".to_string())
    } else {
        "apunte_export.zip".to_string()
    };

    // 2. Descargar los bytes del ZIP
    let download_url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?alt=media",
        file_id
    );
    let download_res = client
        .get(&download_url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Error descargando archivo de Drive: {}", e))?;

    if !download_res.status().is_success() {
        let err_msg = download_res.text().await.unwrap_or_default();
        return Err(format!("Error en la descarga de Drive: {}", err_msg));
    }

    let zip_bytes = download_res
        .bytes()
        .await
        .map_err(|e| format!("Error leyendo bytes del archivo: {}", e))?;

    // 3. Guardar temporalmente en disco para usar extraer_zip
    let temp_zip_path = std::env::temp_dir().join(&file_name);
    fs::write(&temp_zip_path, zip_bytes).map_err(|e| e.to_string())?;

    let fecha_actual = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();

    // 4. Invocar extraer_zip
    let res_apunte = super::extraer_zip(
        materia_codigo,
        temp_zip_path.to_string_lossy().to_string(),
        ruta_destino,
        fecha_actual.clone(),
        fecha_actual,
        state.clone(),
    );

    // 5. Eliminar el archivo temporal descargado
    let _ = fs::remove_file(&temp_zip_path);

    let mut apunte = res_apunte?;

    // 6. Marcar el apunte recién importado con sincronizar_drive = 1 en SQLite
    {
        let db = state.db.lock().unwrap();
        let _ = db.execute(
            "UPDATE APUNTE SET sincronizar_drive = 1 WHERE codigo_apunte = ?1",
            (apunte.codigo_apunte,),
        );
    }
    apunte.sincronizar_drive = true;

    Ok(apunte)
}

/// Sincroniza al inicio: comprueba los apuntes locales que tienen sincronizar_drive = 1.
/// Si en Drive hay una versión más reciente (por más de SYNC_THRESHOLD_SECS), descarga
/// el ZIP y actualiza los archivos locales.
///
/// Nota sobre zona horaria: `ult_modificacion` en SQLite se guarda en hora LOCAL del sistema.
/// Se convierte con `chrono::Local` para que el SO aplique automáticamente el offset correcto
/// (ej: UTC-3 en Argentina) antes de comparar con la fecha UTC de Drive.
#[tauri::command]
pub async fn sincronizar_apuntes_registrados(
    app: AppHandle,
    state: State<'_, DbState>,
) -> Result<Vec<String>, String> {
    // 1. Obtener apuntes con sincronizar_drive activo
    let apuntes_a_sincronizar: Vec<(u32, String, String, String)> = {
        let db = state.db.lock().unwrap();
        let mut stmt = db
            .prepare("SELECT codigo_apunte, tema, ruta, ult_modificacion FROM APUNTE WHERE sincronizar_drive = 1")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut list = Vec::new();
        for r in rows {
            if let Ok(item) = r {
                list.push(item);
            }
        }
        list
    };

    if apuntes_a_sincronizar.is_empty() {
        eprintln!("[Drive Sync] No hay apuntes con sincronización activa. Nada que hacer.");
        return Ok(Vec::new());
    }

    eprintln!(
        "[Drive Sync] Iniciando sincronización para {} apunte(s).",
        apuntes_a_sincronizar.len()
    );

    // 2. Obtener lista de archivos en Drive
    let drive_files = match listar_apuntes_drive(app.clone()).await {
        Ok(files) => files,
        Err(e) => {
            eprintln!("[Drive Sync] No se pudo listar Drive: {}", e);
            return Ok(Vec::new());
        }
    };

    eprintln!(
        "[Drive Sync] Archivos encontrados en Drive: {}",
        drive_files.len()
    );

    let token = match obtener_access_token_valido(&app).await {
        Ok(t) => t,
        Err(_) => return Ok(Vec::new()),
    };
    let client = reqwest::Client::new();
    let mut actualizados = Vec::new();

    // SQLite guarda la fecha sin segundos (formato HH:MM), lo que introduce hasta 59s
    // de imprecisión. Usamos un umbral de 60 segundos para evitar falsos positivos.
    const SYNC_THRESHOLD_SECS: i64 = 60;

    for (_codigo, tema, ruta, ult_mod_local) in apuntes_a_sincronizar {
        let expected_name = format!("{}_export.zip", tema);
        eprintln!("[Drive Sync] ─── Evaluando apunte: \"{}\"", tema);

        let drive_item = drive_files.iter().find(|f| f.name == expected_name);

        if let Some(item) = drive_item {
            // Parsear fecha de Drive (viene en RFC3339 UTC, ej: "2026-09-07T12:00:00.000Z")
            let drive_dt = DateTime::parse_from_rfc3339(&item.modified_time)
                .map(|dt| dt.with_timezone(&Utc))
                .ok();

            // Parsear la fecha local como hora local del sistema y convertir a UTC.
            // chrono::Local usa la timezone del SO automáticamente (ej: America/Argentina/Buenos_Aires).
            // from_local_datetime devuelve None si la hora es ambigua (cambio de horario de verano).
            let local_dt = NaiveDateTime::parse_from_str(&ult_mod_local, "%Y-%m-%d %H:%M")
                .or_else(|_| NaiveDateTime::parse_from_str(&ult_mod_local, "%Y/%m/%d %H:%M"))
                .ok()
                .and_then(|ndt| chrono::Local.from_local_datetime(&ndt).single())
                .map(|ldt| ldt.with_timezone(&Utc));

            eprintln!("[Drive Sync]   📅 Fecha Drive  : {}", item.modified_time);
            match &local_dt {
                Some(ldt) => eprintln!(
                    "[Drive Sync]   📅 Fecha local  : {} (local) → {}Z",
                    ult_mod_local,
                    ldt.format("%Y-%m-%dT%H:%M:%S")
                ),
                None => eprintln!(
                    "[Drive Sync]   ⚠️  Fecha local  : no se pudo parsear \"{}\"",
                    ult_mod_local
                ),
            }

            let (debe_actualizar, diff_secs) = match (drive_dt, local_dt) {
                (Some(ddt), Some(ldt)) => {
                    let diff = (ddt - ldt).num_seconds();
                    eprintln!(
                        "[Drive Sync]   ⏱  Diferencia   : {} segundos (Drive - Local)",
                        diff
                    );
                    (diff > SYNC_THRESHOLD_SECS, diff)
                }
                (Some(_), None) => {
                    eprintln!("[Drive Sync]   ⏱  Diferencia   : fecha local no parseable — se descarga por precaución");
                    (true, i64::MAX)
                }
                _ => {
                    eprintln!("[Drive Sync]   ⚠️  No se pudo comparar fechas — se omite");
                    (false, 0)
                }
            };

            if debe_actualizar {
                eprintln!(
                    "[Drive Sync]   ⬇️  DESCARGANDO — Drive es más nuevo por +{} segundos",
                    diff_secs
                );
                let download_url = format!(
                    "https://www.googleapis.com/drive/v3/files/{}?alt=media",
                    item.id
                );

                if let Ok(res) = client.get(&download_url).bearer_auth(&token).send().await {
                    if res.status().is_success() {
                        if let Ok(bytes) = res.bytes().await {
                            let temp_zip = std::env::temp_dir().join(&expected_name);
                            if fs::write(&temp_zip, &bytes).is_ok() {
                                if let Some(parent_dir) = Path::new(&ruta).parent() {
                                    // Extraer ZIP directamente sobre la carpeta local del apunte
                                    if let Ok(file) = fs::File::open(&temp_zip) {
                                        if let Ok(mut archive) = zip::ZipArchive::new(file) {
                                            let _ = archive.extract(parent_dir);
                                        }
                                    }
                                    // Normalizar referencias de imágenes en el .md
                                    let note_path = Path::new(&ruta);
                                    if let Ok(contenido) = fs::read_to_string(note_path) {
                                        let normalizado =
                                            super::normalizar_rutas_imagenes(&contenido);
                                        if normalizado != contenido {
                                            let _ = fs::write(note_path, normalizado);
                                        }
                                    }
                                    // Actualizar fecha en SQLite
                                    let nueva_fecha =
                                        chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
                                    let db = state.db.lock().unwrap();
                                    let _ = db.execute(
                                        "UPDATE APUNTE SET ult_modificacion = ?1 WHERE ruta = ?2",
                                        (&nueva_fecha, &ruta),
                                    );
                                    actualizados.push(tema.clone());
                                    eprintln!(
                                        "[Drive Sync]   ✅ Actualización completada: \"{}\"",
                                        tema
                                    );
                                }
                                let _ = fs::remove_file(&temp_zip);
                            }
                        }
                    }
                }
            } else {
                eprintln!(
                    "[Drive Sync]   ✅ SALTAR — Drive no es más nuevo (diff={}s, umbral={}s). Sin descarga.",
                    diff_secs, SYNC_THRESHOLD_SECS
                );
            }
        } else {
            eprintln!(
                "[Drive Sync]   ℹ️  No se encontró \"{}\" en Drive. Omitiendo.",
                expected_name
            );
        }
    }

    eprintln!(
        "[Drive Sync] ─── Sincronización finalizada. Apuntes actualizados: {}",
        actualizados.len()
    );
    Ok(actualizados)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_leer_credenciales_env() {
        let id = default_client_id();
        let secret = default_client_secret();
        assert!(!id.is_empty(), "El Client ID no debería estar vacío si .env existe");
        assert!(!secret.is_empty(), "El Client Secret no debería estar vacío si .env existe");
        assert!(id.contains("apps.googleusercontent.com"));
    }
}

