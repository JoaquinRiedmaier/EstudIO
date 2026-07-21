mod estructuras;
use base64::Engine;
use chrono::{Duration, NaiveDateTime};
use estructuras::{Apunte, Evento, Materia};
use image::ImageFormat;
use rusqlite::{Connection, Result};
use std::fs;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};
use uuid::Uuid;
//Fechas en formato YYYY/MM/DD aca, pero en frontend se usa DD/MM/YYYY
//
struct DbState {
    db: Mutex<Connection>,
}
// Funciones para entidades
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '$' | '%' | '^' | '&'
            | '~' | '`' | '!' | '=' | '+' | '-' | ';' | ',' | '.' | ' ' => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn calcular_fecha_recordatorio(
    fecha_str: &str,
    hora_str: &str,
    opcion: u32,
) -> Result<String, String> {
    // Parseo de fecha y hora (Formato YYYY/MM/DD HH:MM)
    let datetime_str = format!("{} {}", fecha_str, hora_str);
    let dt = NaiveDateTime::parse_from_str(&datetime_str, "%Y/%m/%d %H:%M")
        .map_err(|_| "Formato de fecha/hora inválido. Use YYYY/MM/DD HH:MM".to_string())?;

    let recordatorio = match opcion {
        0 => dt - Duration::hours(1),
        1 => dt - Duration::days(1),
        2 => dt - Duration::weeks(1),
        3 => dt - Duration::days(30), // Aproximación de mes
        _ => return Err("Opción de recordatorio inválida".to_string()),
    };

    Ok(recordatorio.format("%Y/%m/%d %H:%M").to_string())
}

// Funciones de manejo de entidades y bdd
fn inicio(app: &tauri::App) -> Connection {
    let dir = app
        .path()
        .app_local_data_dir()
        .expect("Error resolviendo ruta");
    std::fs::create_dir_all(&dir).expect("Error creando carpeta del SO");
    let ruta_db = dir.join("mi_DB.db3");

    let conexion = Connection::open(ruta_db).expect("error conectando a sqlite"); //Autoincremental quita logica de valor siguiente
    conexion
        .execute(
            "CREATE TABLE IF NOT EXISTS MATERIA (
                    codigo INTEGER PRIMARY KEY AUTOINCREMENT,
                    nombre TEXT NOT NULL,
                    ano INTEGER NOT NULL,
                    cuatrimestre INTEGER NOT NULL,
                    anual BOOLEAN NOT NULL
                )",
            (),
        )
        .expect("Error Creando La Tabla MATERIA");

    conexion
        .execute(
            "CREATE TABLE IF NOT EXISTS APUNTE (
                codigo_apunte INTEGER PRIMARY KEY AUTOINCREMENT,
                tema TEXT NOT NULL,
                materia_codigo INTEGER NOT NULL,
                fecha_creacion TEXT NOT NULL,
                ult_modificacion TEXT NOT NULL,

                ruta TEXT NOT NULL,

                FOREIGN KEY (materia_codigo)
                    REFERENCES MATERIA(codigo)
                    ON UPDATE CASCADE
                    ON DELETE CASCADE
            )",
            (),
        )
        .expect("Error Creando La Tabla APUNTE");

    conexion //Se, creamos evento
        .execute(
            "CREATE TABLE IF NOT EXISTS EVENTO (
                codigo_evento INTEGER PRIMARY KEY AUTOINCREMENT,
                fecha TEXT NOT NULL,
                hora TEXT,
                fecha_recordar TEXT NOT NULL,
                nombre TEXT NOT NULL,
                descripcion TEXT
            )",
            (),
        )
        .expect("Error Creando La Tabla EVENTO");
    conexion //Indice Btree rapido como toreto
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_evento_fecha ON EVENTO(fecha_recordar)",
            (),
        )
        .expect("Error Creando Índice en EVENTO(fecha_recordar)");
    conexion
}

#[tauri::command]
fn crear_materia(
    nombre: String,
    ano: u8,
    cuatrimestre: u8,
    anual: bool,
    state: State<'_, DbState>,
) -> Result<String, String> {
    if ano < 1 || ano > 6 {
        // valores compatibles con la mayoria de carreras
        return Err("Año inválido. Debe ser entre 1 y 5.".to_string());
    }
    if cuatrimestre != 1 && cuatrimestre != 2 && cuatrimestre != 0 {
        return Err("Cuatrimestre inválido. Debe ser 1 o 2.".to_string());
    }
    let nombre = sanitize_filename(&nombre);
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO MATERIA (nombre, ano, cuatrimestre, anual) VALUES (?1, ?2, ?3, ?4)",
        (nombre, ano, cuatrimestre, anual),
    )
    .map_err(|e| format!("Error registrando la materia: {}", e))?;

    Ok("== Materia registrada exitosamente ==".to_string())
}

#[tauri::command]
fn mostrar_materias(state: State<'_, DbState>) -> Result<Vec<Materia>, String> {
    let db = state.db.lock().unwrap();
    let mut materias_stmt = db
        .prepare("SELECT codigo, nombre, ano, cuatrimestre, anual FROM MATERIA")
        .map_err(|e| format!("No es posible crear el statement: {}", e))?;

    let iterador = materias_stmt
        .query_map([], |registro| {
            let codigo_val = registro.get::<usize, rusqlite::types::Value>(0)?;
            let codigo = match codigo_val {
                rusqlite::types::Value::Integer(i) => i as u32,
                rusqlite::types::Value::Text(t) => t.parse().unwrap_or(0),
                _ => 0,
            };

            Ok(Materia {
                codigo,
                nombre: registro.get(1)?,
                ano: registro.get(2)?,
                cuatrimestre: registro.get(3)?,
                anual: registro.get(4)?,
            })
        })
        .map_err(|e| format!("Error consultando materias: {}", e))?;

    let mut result = Vec::new();
    for materia in iterador {
        match materia {
            Ok(m) => result.push(m),
            Err(e) => eprintln!("Error leyendo materia: {}", e),
        }
    }

    Ok(result)
}

#[tauri::command]
fn crear_apunte(
    tema: String,
    materia_codigo: String,
    fecha_creacion: String,
    ult_modificacion: String,
    ruta: String,
    state: State<'_, DbState>,
) -> Result<Apunte, String> {
    let tema = sanitize_filename(&tema);
    let materia_codigo = materia_codigo.parse::<u32>().unwrap();
    let db = state.db.lock().unwrap();
    let db_has_materias: usize = db
        .query_row("SELECT COUNT(*) FROM MATERIA", [], |row| row.get(0))
        .unwrap_or(0);
    if db_has_materias == 0 {
        return Err("No hay materias registradas!!!".to_string());
    }

    let nombre_archivo = format!("{}.md", tema);
    let ruta_completa = Path::new(&ruta).join(nombre_archivo);
    let _ = OpenOptions::new()
        .write(true)
        .create(true)
        .open(&ruta_completa)
        .map_err(|e| format!("Error creando el archivo: {}", e))?;
    let ruta = ruta_completa.to_str().unwrap(); //Se guarda la ruta completa, facilita la apertura

    db.execute(
        "INSERT INTO APUNTE (tema, materia_codigo, fecha_creacion, ruta, ult_modificacion) VALUES (?1, ?2, ?3, ?4, ?5)",
        (&tema, &materia_codigo, &fecha_creacion, &ruta, &ult_modificacion),
    )
    .map_err(|e| format!("Error registrando el apunte: {}", e))?;

    let apunte_codigo = db.last_insert_rowid() as u32;

    Ok(Apunte {
        codigo_apunte: apunte_codigo,
        materia_codigo,
        fecha_creacion,
        ult_modificacion,
        tema,
        ruta: ruta.to_string(),
    })
}

#[tauri::command]
fn mostrar_ult_modif(state: State<'_, DbState>) -> Result<Vec<Apunte>, String> {
    let db = state.db.lock().unwrap();
    let mut apuntes_consulta = db
        .prepare("SELECT codigo_apunte, materia_codigo, tema, ult_modificacion, ruta FROM APUNTE ORDER BY ult_modificacion DESC LIMIT 5")
        .map_err(|e| format!("No es posible crear el statement: {}", e))?;
    let iterador = apuntes_consulta
        .query_map([], |registro| {
            let codigo_val = registro.get::<usize, rusqlite::types::Value>(0)?;
            let codigo_ap = match codigo_val {
                rusqlite::types::Value::Integer(i) => i as u32,
                rusqlite::types::Value::Text(t) => t.parse().unwrap_or(0),
                _ => 0,
            };
            let codigo_val = registro.get::<usize, rusqlite::types::Value>(1)?;
            let codigo_mat = match codigo_val {
                rusqlite::types::Value::Integer(i) => i as u32,
                rusqlite::types::Value::Text(t) => t.parse().unwrap_or(0),
                _ => 0,
            };

            Ok(Apunte {
                tema: registro.get(2)?,
                ult_modificacion: registro.get(3)?,
                codigo_apunte: codigo_ap,
                materia_codigo: codigo_mat,
                fecha_creacion: "".to_string(),
                ruta: registro.get(4)?,
            })
        })
        .map_err(|e| format!("Error consultando apuntes: {}", e))?;

    let mut result = Vec::new();
    for apunte in iterador {
        match apunte {
            Ok(a) => result.push(a),
            Err(e) => eprintln!("Error leyendo apunte: {}", e),
        }
    }
    Ok(result)
}

#[tauri::command]
fn buscar_apunt_materia(
    materia_codigo: String,
    state: State<'_, DbState>,
) -> Result<Vec<Apunte>, String> {
    let mate_codigo = materia_codigo
        .parse::<u32>()
        .map_err(|_| "El código de la materia no es un número válido".to_string())?;
    let db = state.db.lock().unwrap();
    let mut apuntes_consulta = db
        .prepare("SELECT codigo_apunte, materia_codigo, tema, ult_modificacion, ruta FROM APUNTE WHERE materia_codigo = ?1")
        .map_err(|e| format!("No es posible crear el statement: {}", e))?;
    let iterador = apuntes_consulta
        .query_map([&mate_codigo], |registro| {
            let codigo_val = registro.get::<usize, rusqlite::types::Value>(0)?;
            let codigo_ap = match codigo_val {
                //Codigo apunte
                rusqlite::types::Value::Integer(i) => i as u32,
                rusqlite::types::Value::Text(t) => t.parse().unwrap_or(0),
                _ => 0,
            };
            let codigo_val = registro.get::<usize, rusqlite::types::Value>(1)?;
            let codigo_mat = match codigo_val {
                //Codigo materia
                rusqlite::types::Value::Integer(i) => i as u32,
                rusqlite::types::Value::Text(t) => t.parse().unwrap_or(0),
                _ => 0,
            };

            Ok(Apunte {
                tema: registro.get(2)?,
                ult_modificacion: registro.get(3)?,
                codigo_apunte: codigo_ap,
                materia_codigo: codigo_mat,
                fecha_creacion: "".to_string(),
                ruta: registro.get(4)?,
            })
        })
        .map_err(|e| format!("Error consultando apuntes: {}", e))?;

    let mut result = Vec::new();
    for apunte in iterador {
        match apunte {
            Ok(a) => result.push(a),
            Err(e) => eprintln!("Error leyendo apunte: {}", e),
        }
    }
    Ok(result)
}

#[tauri::command]
fn abrir_apunte(path: String) -> Result<String, String> {
    eprintln!("Abriendo apunte: {}", path);
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn guardar_apunte(
    path: String,
    content: String,
    apunte_codigo: String,
    state: State<'_, DbState>,
    fecha_modif: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let apunte_puro = apunte_codigo.parse::<u32>().unwrap();

    db.execute(
        "UPDATE APUNTE SET ult_modificacion = ?1 WHERE codigo_apunte = ?2",
        (&fecha_modif, &apunte_puro),
    )
    .map_err(|e| e.to_string())?;
    eprintln!("Guardando apunte y actualizando fecha_modif: {}", path);
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn mostrar_eventos(
    state: State<'_, DbState>,
    offset: u32,
    fecha_inicio: String,
    fecha_fin: String,
) -> Result<Vec<Evento>, String> {
    let db = state.db.lock().unwrap();
    let mut eventos_consulta = db
        .prepare(
            "SELECT codigo_evento, fecha, hora, nombre, descripcion, fecha_recordar FROM EVENTO WHERE fecha || ' ' || COALESCE(hora, '00:00') BETWEEN ?1 AND ?2 ORDER BY fecha, COALESCE(hora, '00:00') LIMIT 5 OFFSET ?3",
        )
        .map_err(|e| format!("No es posible mostrar eventos: {}", e))?;
    let iterador = eventos_consulta
        .query_map([fecha_inicio, fecha_fin, offset.to_string()], |registro| {
            let hora: Option<String> = registro.get(2)?;
            let descripcion: Option<String> = registro.get(4)?;

            Ok(Evento {
                codigo_evento: registro.get(0)?,
                fecha: registro.get(1)?,
                hora: hora.unwrap_or_default(),
                fecha_recordar: registro.get(5)?,
                nombre: registro.get(3)?,
                descripcion: descripcion.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("Error consultando eventos: {}", e))?;

    let mut result = Vec::new();
    for evento in iterador {
        match evento {
            Ok(e) => result.push(e),
            Err(e) => eprintln!("Error leyendo evento: {}", e),
        }
    }
    Ok(result)
}

#[tauri::command]
fn eventos_hoy(
    state: State<'_, DbState>,
    fecha_inicio: String,
    fecha_fin: String,
) -> Result<Vec<Evento>, String> {
    let db = state.db.lock().unwrap();
    let mut eventos_consulta = db
        .prepare(
            "SELECT codigo_evento, fecha, hora, nombre, descripcion, fecha_recordar FROM EVENTO WHERE fecha_recordar || ' ' || COALESCE(hora, '00:00') BETWEEN ?1 AND ?2 ORDER BY fecha_recordar, COALESCE(hora, '00:00')",
        )
        .map_err(|e| format!("No es posible mostrar eventos: {}", e))?;
    let iterador = eventos_consulta
        .query_map([fecha_inicio, fecha_fin], |registro| {
            let hora: Option<String> = registro.get(2)?;
            let descripcion: Option<String> = registro.get(4)?;

            Ok(Evento {
                codigo_evento: registro.get(0)?,
                fecha: registro.get(1)?,
                hora: hora.unwrap_or_default(),
                fecha_recordar: registro.get(5)?,
                nombre: registro.get(3)?,
                descripcion: descripcion.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("Error consultando eventos: {}", e))?;

    let mut result = Vec::new();
    for evento in iterador {
        match evento {
            Ok(e) => result.push(e),
            Err(e) => eprintln!("Error leyendo evento: {}", e),
        }
    }
    Ok(result)
}

#[tauri::command]
fn crear_evento(
    fecha: String,
    hora: String,
    opcion_recordar: u32, // 0 -> Hora antes, 1 -> Dia antes, 2 -> Semana antes, 3 -> Mes antes
    nombre: String,
    descripcion: String,
    state: State<'_, DbState>,
) -> Result<(), String> {
    // Implementar logica para formar fecha_recordar de evento
    if opcion_recordar == 0 && hora.is_empty() {
        return Err("Ingresa una hora si queres que se te recuerde una hora antes".to_string());
    }

    let fecha_recordar = calcular_fecha_recordatorio(&fecha, &hora, opcion_recordar)?;
    eprintln!("fecha_recordar: {}", fecha_recordar);
    let db = state.db.lock().unwrap(); //Lock
    db.execute(
        "INSERT INTO EVENTO (fecha, hora, nombre, descripcion, fecha_recordar) VALUES (?1, ?2, ?3, ?4, ?5)",
        (&fecha, &hora, &nombre, &descripcion, &fecha_recordar),
    )
    .map_err(|e| e.to_string())?;
    eprintln!("Evento creado!!!");
    Ok(())
}
// Funcion interna, por bloqueo de BDD
fn eliminar_apunte_interno(
    db: &rusqlite::Connection,
    codigo_apunte: u32,
    ruta: &str,
) -> Result<(), String> {
    // Borramos el apunte de la BDD
    db.execute(
        "DELETE FROM APUNTE WHERE codigo_apunte IS ?1",
        (codigo_apunte,),
    )
    .map_err(|e| format!("Error borrando el apunte {}: {}", codigo_apunte, e))?;

    // Borramos el archivo. Usamos if let para no colapsar la app si el archivo ya no existe.
    if let Err(e) = fs::remove_file(ruta) {
        eprintln!(
            "Advertencia: No se pudo borrar el archivo del apunte {}: {}",
            codigo_apunte, e
        );
    }

    Ok(())
}

#[tauri::command]
fn borrar_apunte(
    codigo_apunte: String,
    state: State<'_, DbState>,
    ruta: String,
) -> Result<(), String> {
    let codigo_val = codigo_apunte.parse::<u32>().map_err(|e| e.to_string())?;
    let db = state.db.lock().unwrap();
    eliminar_apunte_interno(&db, codigo_val, &ruta)
}

#[tauri::command]
fn borrar_materia(codigo_materia: String, state: State<'_, DbState>) -> Result<(), String> {
    let codigo_val = codigo_materia.parse::<u32>().unwrap();
    let db = state.db.lock().unwrap();
    //Borramos los apuntes asociados a la materia
    let mut apuntes_a_borrar: Vec<(u32, String)> = Vec::new();
    {
        let mut consulta = db
            .prepare("SELECT codigo_apunte, ruta FROM APUNTE WHERE materia_codigo IS ?1")
            .map_err(|e| format!("Error borrando los apuntes: {}", e))?;

        let iterador = consulta
            .query_map([codigo_val], |registro| {
                let codigo_apunte: u32 = registro.get(0)?;
                let ruta: String = registro.get(1)?;
                Ok((codigo_apunte, ruta))
            })
            .map_err(|e| format!("Error consultando eventos: {}", e))?;

        for apunte in iterador {
            if let Ok(apunte) = apunte {
                apuntes_a_borrar.push(apunte);
            }
        }
    }

    // Borramos los apuntes de la BDD
    for (codigo, ruta) in apuntes_a_borrar {
        if let Err(e) = eliminar_apunte_interno(&db, codigo, &ruta) {
            eprintln!("Error borrando archivos propios de la materia: {}", e);
        }
    }

    // Borramos la materia de la BDD
    db.execute("DELETE FROM MATERIA WHERE codigo IS ?1", (codigo_val,))
        .map_err(|e| format!("Error borrando la materia: {}", e))?;
    Ok(())
}

#[tauri::command]
fn borrar_evento(codigo_evento: String, state: tauri::State<DbState>) -> Result<(), String> {
    let codigo_ev_num = codigo_evento
        .parse::<i32>()
        .map_err(|e| format!("Error parsing codigo_evento: {}", e))?;
    let db = state.db.lock().unwrap();
    db.execute(
        "DELETE FROM EVENTO WHERE codigo_evento IS ?1",
        (codigo_ev_num,),
    )
    .map_err(|e| format!("Error borrando el evento: {}", e))?;
    Ok(())
}

#[tauri::command]
fn incorporar_imagenes(ruta_img: String, ruta_apunte: String) -> Result<String, String> {
    // La ruta de la imagen incluye el nombre de la imagen
    // La ruta de la del apunte tiene el nombre del apunte -> Quitar nombre apunte
    // /C:/Usuario/DOCUMENTOS/Facultad/Apuntes/aveas_corpus.md
    let path_destino = Path::new(&ruta_apunte)
        .parent()
        .ok_or_else(|| "No se pudo obtener el directorio destino de la imagen".to_string())?;
    let mut carpeta_recursos = PathBuf::from(path_destino); // /C:/Usuario/DOCUMENTOS/Facultad/Apuntes/
    carpeta_recursos.push(".recursos");

    fs::create_dir_all(&carpeta_recursos).map_err(|e| e.to_string())?; //Crea la carpeta

    //Nombre de la imagen
    let nombre_imagen = Path::new(&ruta_img)
        .file_name()
        .ok_or_else(|| "No se pudo extraer el nombre de la imagen".to_string())?;

    // Construir la ruta destino
    let mut ruta_destino = carpeta_recursos.clone();
    let uuid_unico = Uuid::now_v7().to_string(); //Para que tenga nombre unico
    let extension = Path::new(&nombre_imagen)
        .extension()
        .map(|ext| ext.to_string_lossy().into_owned())
        .unwrap_or("png".to_string());

    let nombre_archivo = if extension.is_empty() {
        uuid_unico
    } else {
        format!("{}.{}", uuid_unico, extension)
    };
    ruta_destino.push(&nombre_archivo);

    let path_imagen = Path::new(&ruta_img); //Convierto de String a Path

    fs::copy(&path_imagen, &ruta_destino).map_err(|e| e.to_string())?;
    eprintln!("Imagen movida exitosamente");
    //Debo recortar la ruta para que sea relativa .recursos/uuid7.formato
    let ruta_relativa = format!(".recursos/{}", nombre_archivo);

    Ok(ruta_relativa)
}

#[tauri::command]
fn paste_imagen(ruta_apunte: String, imagen: String) -> Result<String, String> {
    eprintln!("Se llama a la funcion de paste");
    let path_destino = Path::new(&ruta_apunte)
        .parent()
        .ok_or_else(|| "No se pudo obtener el directorio destino de la imagen".to_string())?;
    let mut carpeta_recursos = PathBuf::from(path_destino);
    carpeta_recursos.push(".recursos"); //Tenemos ruta destino
    fs::create_dir_all(&carpeta_recursos).map_err(|e| e.to_string())?;
    // Convertimos la imagen
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(imagen)
        .map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;

    let nombre_archivo = format!("{}.png", Uuid::now_v7());
    let mut ruta_destino = PathBuf::from(&carpeta_recursos);
    ruta_destino.push(&nombre_archivo);
    eprintln!("Previa a guardar la imagen");
    img.save_with_format(&ruta_destino, ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    let relativa = format!(".recursos/{}", nombre_archivo);
    eprintln!("Imagen movida exitosamente a la ruta: {}", relativa);
    Ok(relativa)
}

#[tauri::command]
fn guardar_pdf(path: String, content_base64: String) -> Result<(), String> {
    eprintln!("Guardando PDF en la ruta: {}", path);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db = inicio(app);
            app.manage(DbState { db: Mutex::new(db) });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            crear_materia,
            mostrar_materias,
            crear_apunte,
            mostrar_ult_modif,
            buscar_apunt_materia,
            abrir_apunte,
            guardar_apunte,
            crear_evento,
            mostrar_eventos,
            eventos_hoy,
            borrar_apunte,
            borrar_materia,
            borrar_evento,
            incorporar_imagenes,
            paste_imagen,
            guardar_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
