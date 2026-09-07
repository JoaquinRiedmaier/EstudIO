mod estructuras;
pub mod google_drive;
use base64::Engine;
use chrono::{Duration, NaiveDateTime};
use estructuras::{Apunte, Evento, Materia, SlotsHorario};
use serde::{Deserialize, Serialize};
use image::ImageFormat;
use rusqlite::{Connection, Result};
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::ZipArchive;
//Fechas en formato YYYY/MM/DD aca, pero en frontend se usa DD/MM/YYYY

pub struct DbState {
    pub db: Mutex<Connection>,
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

    // Migración: agregar columna sincronizar_drive si aún no existe
    let _ = conexion.execute(
        "ALTER TABLE APUNTE ADD COLUMN sincronizar_drive BOOLEAN DEFAULT 0",
        (),
    );

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
    conexion //Indice Btree
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_evento_fecha ON EVENTO(fecha_recordar)",
            (),
        )
        .expect("Error Creando Índice en EVENTO(fecha_recordar)");
    conexion
        .execute(
            "CREATE TABLE IF NOT EXISTS SLOTSHORARIO (
                id_slot INTEGER PRIMARY KEY AUTOINCREMENT,
                titulo TEXT NOT NULL,
                dia_semana INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
                hora_inicio INTEGER NOT NULL,
                hora_fin INTEGER NOT NULL,
                color TEXT NOT NULL DEFAULT '#2c4c3b',
                aula TEXT
            )",
            (),
        )
        .expect("Error Creando La Tabla SLOTSHORARIO");
    conexion
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_slot_dia_hora ON SLOTSHORARIO(dia_semana, hora_inicio)",
            (),
        )
        .expect("Error Creando Índice en SLOTSHORARIO");
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
        "INSERT INTO APUNTE (tema, materia_codigo, fecha_creacion, ruta, ult_modificacion, sincronizar_drive) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
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
        sincronizar_drive: false,
    })
}

#[tauri::command]
fn mostrar_ult_modif(state: State<'_, DbState>) -> Result<Vec<Apunte>, String> {
    let db = state.db.lock().unwrap();
    let mut apuntes_consulta = db
        .prepare("SELECT codigo_apunte, materia_codigo, tema, ult_modificacion, ruta, COALESCE(sincronizar_drive, 0) FROM APUNTE ORDER BY ult_modificacion DESC LIMIT 5")
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

            let sinc: bool = registro.get::<usize, bool>(5).unwrap_or(false);

            Ok(Apunte {
                tema: registro.get(2)?,
                ult_modificacion: registro.get(3)?,
                codigo_apunte: codigo_ap,
                materia_codigo: codigo_mat,
                fecha_creacion: "".to_string(),
                ruta: registro.get(4)?,
                sincronizar_drive: sinc,
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
        .prepare("SELECT codigo_apunte, materia_codigo, tema, ult_modificacion, ruta, COALESCE(sincronizar_drive, 0) FROM APUNTE WHERE materia_codigo = ?1")
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

            let sinc: bool = registro.get::<usize, bool>(5).unwrap_or(false);

            Ok(Apunte {
                tema: registro.get(2)?,
                ult_modificacion: registro.get(3)?,
                codigo_apunte: codigo_ap,
                materia_codigo: codigo_mat,
                fecha_creacion: "".to_string(),
                ruta: registro.get(4)?,
                sincronizar_drive: sinc,
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
fn cambiar_sincronizar_drive(
    codigo_apunte: u32,
    sincronizar: bool,
    state: State<'_, DbState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE APUNTE SET sincronizar_drive = ?1 WHERE codigo_apunte = ?2",
        (sincronizar, codigo_apunte),
    )
    .map_err(|e| format!("Error actualizando sincronizar_drive: {}", e))?;
    Ok(())
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
    // Normalizar cualquier ruta absoluta de imagenes para que sea siempre .recursos/<nombre>
    let contenido_normalizado = normalizar_rutas_imagenes(&content);

    eprintln!("Guardando apunte y actualizando fecha_modif: {}", path);
    fs::write(path, contenido_normalizado).map_err(|e| e.to_string())
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
    // Borramos primero las imagenes
    let path_apunte = Path::new(&ruta);
    let archivo_string = fs::read_to_string(&path_apunte).map_err(|e| e.to_string())?; // Aca carga todo en ram, problema archivos grandes
    let carpeta_imagenes = PathBuf::from(&ruta).parent().map(|p| p.join(".recursos"));
    //Revisamos el archivo y borramos las imagenes propias del apunte
    for linea in archivo_string.lines() {
        if linea.contains(".recursos") {
            // Tiene imagen
            if let Some(fragment) = linea.split("%2F").last() {
                let extensiones = [
                    ".png", ".jpg", ".jpeg", ".webp", ".PNG", ".JPG", ".WEBP", ".JPEG",
                ];
                // varia tamaño, ref: <img src="asset://localhost/%2Fhome%2Fusuario%2Fdocumentos%2Fanotaciones%2Ffacultad%2F.recursos%2F019fcdfe-54e1-7651-af58-3536ed7bf26b.png" alt="" width="434" height="256">
                for ext in extensiones {
                    if let Some(pos) = fragment.find(ext) {
                        let imagen = fragment[..pos + ext.len()].to_string();
                        if let Some(ref dir) = carpeta_imagenes {
                            let ruta_imagen = dir.join(imagen);
                            if let Err(e) = fs::remove_file(&ruta_imagen) {
                                eprintln!("Error al eliminar {:?}: {}", ruta_imagen, e);
                            } else {
                                println!("Imagen eliminada con éxito: {:?}", ruta_imagen);
                            }
                        }
                        break;
                    }
                }
            }
        }
    }
    if let Some(ref dir) = carpeta_imagenes {
        if dir.exists() {
            let esta_vacia = match fs::read_dir(dir) {
                Ok(mut entries) => entries.next().is_none(), // `true` si no hay ningún archivo/subcarpeta
                Err(_) => false, // Ante la duda o error de permisos, preferimos no tocarla
            };
            if esta_vacia {
                // fs::remove_dir solo borra directorios vacíos
                if let Err(e) = fs::remove_dir(dir) {
                    eprintln!("No se pudo eliminar la carpeta .recursos: {}", e);
                } else {
                    eprintln!("Carpeta .recursos eliminada correctamente por estar vacía");
                }
            } else {
                eprintln!("La carpeta .recursos todavía contiene imágenes de otros apuntes.");
            }
        }
    }
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

#[tauri::command]
fn crear_zip(path_apunte: String) -> Result<String, String> {
    // Recibe el path del apunte (Incluye nombre apunte), arma el zip
    // Primero busca lista de imagenes a enviar
    let path_destino = Path::new(&path_apunte);
    let archivo_string = fs::read_to_string(&path_destino).map_err(|e| e.to_string())?;

    let directorio = Path::new(&path_apunte)
        .parent()
        .ok_or_else(|| "No se pudo extraer el directorio para zip en backend".to_string())?;
    let mut carpeta_recursos = directorio.to_path_buf();
    carpeta_recursos.push(".recursos"); // Carpeta con imagenes

    // Buscar todas las imagenes de .recursos que aparezcan referenciadas en el apunte
    let mut imagenes: Vec<String> = Vec::new();
    if carpeta_recursos.exists() {
        if let Ok(entries) = fs::read_dir(&carpeta_recursos) {
            for entry in entries.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();
                if archivo_string.contains(&file_name) {
                    imagenes.push(file_name);
                }
            }
        }
    }

    // Ahora si el zip
    let mut nombre_apunte = Path::new(&path_apunte)
        .file_stem() // Sin extension del apunte
        .ok_or_else(|| "No se pudo extraer el nombre del apunte".to_string())?
        .to_string_lossy()
        .into_owned();
    let mut nombre_zip = nombre_apunte.clone();
    nombre_zip.push_str("_export.zip");

    let mut ruta_zip = directorio.to_path_buf();
    ruta_zip.push(&nombre_zip); // El zip se guarda y crea junto a los apuntes
    let file = std::fs::File::create(&ruta_zip).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);

    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true)
        .unix_permissions(0o755);

    // Mover Imagenes al ZIP
    for imagen in imagenes {
        let ruta_origen = carpeta_recursos.join(&imagen);
        if ruta_origen.exists() {
            let ruta_in_zip = format!(".recursos/{}", &imagen);
            zip.start_file(ruta_in_zip, options.clone())
                .map_err(|e| e.to_string())?;
            let mut archivo_imagen = fs::File::open(&ruta_origen).map_err(|e| e.to_string())?;
            std::io::copy(&mut archivo_imagen, &mut zip).map_err(|e| e.to_string())?;
        } else {
            eprintln!(
                "Problema copiando imagenes en zip, no se encontró {}",
                &ruta_origen.to_string_lossy()
            );
        }
    }

    // Normalizar el contenido .md antes de guardarlo en el ZIP para garantizar rutas relativas
    let contenido_normalizado = normalizar_rutas_imagenes(&archivo_string);
    if contenido_normalizado != archivo_string {
        let _ = fs::write(&path_apunte, &contenido_normalizado);
    }

    // Mover el apunte .md al ZIP
    nombre_apunte.push_str(".md");
    zip.start_file(nombre_apunte, options.clone())
        .map_err(|e| e.to_string())?;
    zip.write_all(contenido_normalizado.as_bytes())
        .map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;

    Ok(nombre_zip)
}

fn debe_abrir_zip<R: Read + Seek>(archive: &mut ZipArchive<R>, nombre_esperado: &str) -> bool {
    let mut estructura = true;
    let mut formatos_correctos = true;
    let mut tiene_md_esperado = false;
    let archivo_md_esperado = format!("{}.md", nombre_esperado);

    for i in 0..archive.len() {
        let file = match archive.by_index(i) {
            Ok(f) => f,
            Err(_) => return false,
        };
        let name = file.name();
        // raiz md + .recursos
        if !name.starts_with(".recursos/") && name.contains('/') {
            estructura = false; // No cumple con la estructura
        }

        // Vemos que sean imagenes en la carpeta recursos
        if name.starts_with(".recursos/") {
            let var = name.to_lowercase();
            if !var.ends_with(".jpg")
                && !var.ends_with(".png")
                && !var.ends_with(".webp")
                && !var.ends_with(".jpeg")
            {
                formatos_correctos = false;
            }
        }

        // Nombre md
        if name == archivo_md_esperado {
            tiene_md_esperado = true;
        } else if name.ends_with(".md") && !name.contains('/') {
            tiene_md_esperado = false; // Redundante
        }
    }
    tiene_md_esperado && formatos_correctos && estructura
}

// Normaliza las referencias a imagenes de una linea para que apunten a la carpeta
// .recursos de forma relativa y con "/" como separador (valido en Windows, macOS y Linux).
// Ej: asset://localhost/%2Fhome%2Fuser%2FApuntes%2F.recursos%2Fx.png -> .recursos/x.png
fn normalizar_referencias(linea: &str) -> String {
    // Marcadores que anteceden al nombre del archivo dentro de una referencia a imagen
    const MARCADORES: [&str; 2] = [
        "%2F.recursos%2F", // URL codificada: asset://localhost/%2F...%2F.recursos%2F<archivo>
        "/.recursos/",     // Ruta absoluta sin codificar: /.../.recursos/<archivo>
    ];
    // Delimitadores que cierran el nombre del archivo en markdown o HTML
    const FIN_NOMBRE: [char; 10] = ['(', ')', '"', '\'', ' ', '\t', '\n', '\r', '<', '>'];

    let mut resultado = String::with_capacity(linea.len());
    let mut resto = linea;

    while !resto.is_empty() {
        // Aparicion mas temprana de cualquiera de los marcadores
        let siguiente = MARCADORES
            .iter()
            .filter_map(|m| resto.find(m).map(|pos| (pos, *m)))
            .min_by_key(|(pos, _)| *pos);
        let (pos, marcador) = match siguiente {
            Some(encontrado) => encontrado,
            None => break,
        };

        // Inicio del valor del atributo/URL: ultimo delimitador de apertura antes del marcador
        let inicio_valor = resto[..pos]
            .rfind(['(', '"', '\'', ' ', '\n', '\r'])
            .map_or(0, |i| i + 1);

        // Nombre + extension que le sigue al marcador
        let despues = &resto[pos + marcador.len()..];
        let fin = despues.find(FIN_NOMBRE).unwrap_or(despues.len());
        let nombre_archivo = &despues[..fin];

        // Caso anomalo (sin nombre o con subrutas/codificacion extra): conservar el original
        if nombre_archivo.is_empty() || nombre_archivo.contains('/') || nombre_archivo.contains('%')
        {
            resultado.push_str(&resto[..pos + marcador.len()]);
            resto = despues;
            continue;
        }

        // Reconstruimos el valor con la ruta relativa y separador "/"
        resultado.push_str(&resto[..inicio_valor]);
        resultado.push_str(".recursos/");
        resultado.push_str(nombre_archivo);
        resto = &despues[fin..];
    }
    resultado.push_str(resto);
    resultado
}

// Normaliza todas las rutas de imagenes de un apunte a rutas relativas a .recursos,
// reemplazando URLs absolutas (asset://localhost/...) invalidas en otra maquina.
pub(crate) fn normalizar_rutas_imagenes(contenido: &str) -> String {
    let termina_nueva_linea = contenido.ends_with('\n');
    let lineas: Vec<String> = contenido
        .lines()
        .map(|linea| {
            // Solo procesamos lineas con posibles referencias a imagenes
            if linea.contains("<img")
                || linea.contains("](")
                || linea.contains("asset:")
                || linea.contains("http")
            {
                normalizar_referencias(linea)
            } else {
                linea.to_string()
            }
        })
        .collect();
    let mut resultado = lineas.join("\n");
    if termina_nueva_linea {
        resultado.push('\n');
    }
    resultado
}

#[tauri::command]
fn extraer_zip(
    materia_codigo: String,
    ruta_zip: String,     // Incluye el nombre de archivo
    ruta_destino: String, //Debe ser un directorio
    fecha_creacion: String,
    ult_modificacion: String,
    state: tauri::State<DbState>,
) -> Result<Apunte, String> {
    // Descomprimir
    let file = fs::File::open(Path::new(&ruta_zip)).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let nombre_zip = Path::new(&ruta_zip)
        .file_stem()
        .ok_or_else(|| "No se pudo extraer el nombre del apunte".to_string())?
        .to_string_lossy()
        .into_owned();
    let nombre_apunte = match nombre_zip.strip_suffix("_export") {
        Some(s) => s.to_string(),
        None => nombre_zip,
    };
    //Verificar que tenga estructura de apunte y carpeta de recursos
    if debe_abrir_zip(&mut archive, &nombre_apunte) {
        archive
            .extract(Path::new(&ruta_destino))
            .map_err(|e| e.to_string())?; //Teoricamente pisa solo documentos identicos
    } else {
        return Err("Problema habriendo el zip INSEGURO".to_string());
    }

    // El apunte puede traer rutas absolutas a imagenes (asset://localhost/...)
    // que solo son validas en la maquina de origen. Se normalizan a rutas
    // relativas (.recursos/<archivo>) antes de registrar el apunte en la BDD.
    let note_path = Path::new(&ruta_destino).join(format!("{}.md", nombre_apunte));
    let contenido = fs::read_to_string(&note_path).map_err(|e| e.to_string())?;
    let contenido_normalizado = normalizar_rutas_imagenes(&contenido);
    if contenido_normalizado != contenido {
        fs::write(&note_path, contenido_normalizado).map_err(|e| e.to_string())?;
    }

    // Registrar apunte en BDD
    crear_apunte(
        nombre_apunte,
        materia_codigo,
        fecha_creacion,
        ult_modificacion,
        ruta_destino,
        state,
    )
}

#[tauri::command]
fn crear_slot_horario(
    titulo: String,
    dia_semana: u8,
    hora_inicio: u16,
    hora_fin: u16,
    color: String,
    aula: Option<String>,
    state: State<'_, DbState>,
) -> Result<String, String> {
    if hora_fin <= hora_inicio {
        return Err("La hora de fin debe ser posterior a la hora de inicio.".to_string());
    }
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO SLOTSHORARIO (titulo, dia_semana, hora_inicio, hora_fin, color, aula) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![titulo, dia_semana, hora_inicio, hora_fin, color, aula],
    )
    .map_err(|e| format!("Error registrando el slot horario: {}", e))?;

    Ok("== Slot horario registrado exitosamente ==".to_string())
}

#[tauri::command]
fn borrar_slot_horario(id_slot: u32, state: State<'_, DbState>) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM SLOTSHORARIO WHERE id_slot = ?1", (id_slot,))
        .map_err(|e| format!("Error borrando el slot horario: {}", e))?;

    Ok("== Slot horario borrado exitosamente ==".to_string())
}

#[tauri::command]
fn mostrar_slots_horario(state: State<'_, DbState>) -> Result<Vec<SlotsHorario>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT id_slot, titulo, dia_semana, hora_inicio, hora_fin, color, aula \
             FROM SLOTSHORARIO ORDER BY dia_semana, hora_inicio",
        )
        .map_err(|e| format!("Error preparando consulta de slots: {}", e))?;

    let iterador = stmt
        .query_map([], |row| {
            Ok(SlotsHorario {
                id_slot: row.get::<_, i64>(0)? as u32,
                titulo: row.get(1)?,
                dia_semana: row.get::<_, i64>(2)? as u8,
                hora_inicio: row.get::<_, i64>(3)? as u16,
                hora_fin: row.get::<_, i64>(4)? as u16,
                color: row.get(5)?,
                aula: row.get(6)?,
            })
        })
        .map_err(|e| format!("Error consultando slots: {}", e))?;

    let mut result = Vec::new();
    for slot in iterador {
        match slot {
            Ok(s) => result.push(s),
            Err(e) => eprintln!("Error leyendo slot: {}", e),
        }
    }
    Ok(result)
}

#[tauri::command]
fn borrar_todos_slots(state: State<'_, DbState>) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM SLOTSHORARIO", [])
        .map_err(|e| format!("Error borrando todos los slots: {}", e))?;
    Ok("== Horario borrado exitosamente ==".to_string())
}

// ── Exportar / Importar horario (.json) ───────────────────────────────────────

/// Estructura JSON del archivo .json de horario
#[derive(Serialize, Deserialize)]
struct HorarioExport {
    app: String,
    version: u32,
    slots: Vec<SlotExport>,
}

#[derive(Serialize, Deserialize)]
struct SlotExport {
    dia_semana: u8,
    titulo: String,
    hora_inicio: u16,
    hora_fin: u16,
    color: String,
    aula: Option<String>,
}

/// Exporta todos los slots del horario al archivo indicado en formato JSON (.json)
#[tauri::command]
fn exportar_horario(ruta_destino: String, state: State<'_, DbState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT titulo, dia_semana, hora_inicio, hora_fin, color, aula \
             FROM SLOTSHORARIO ORDER BY dia_semana, hora_inicio",
        )
        .map_err(|e| format!("Error preparando consulta: {}", e))?;

    let iterador = stmt
        .query_map([], |row| {
            Ok(SlotExport {
                titulo: row.get(0)?,
                dia_semana: row.get::<_, i64>(1)? as u8,
                hora_inicio: row.get::<_, i64>(2)? as u16,
                hora_fin: row.get::<_, i64>(3)? as u16,
                color: row.get(4)?,
                aula: row.get(5)?,
            })
        })
        .map_err(|e| format!("Error consultando slots: {}", e))?;

    let mut slots = Vec::new();
    for slot in iterador {
        match slot {
            Ok(s) => slots.push(s),
            Err(e) => eprintln!("Error leyendo slot: {}", e),
        }
    }

    let export = HorarioExport {
        app: "EstudIO".to_string(),
        version: 1,
        slots,
    };

    let json =
        serde_json::to_string_pretty(&export).map_err(|e| format!("Error serializando: {}", e))?;
    fs::write(&ruta_destino, json).map_err(|e| format!("Error escribiendo archivo: {}", e))?;
    Ok(())
}

/// Importa un archivo .json y carga los slots en la DB.
/// Si `reemplazar` es true, borra el horario actual antes de insertar.
#[tauri::command]
fn importar_horario(
    ruta_archivo: String,
    reemplazar: bool,
    state: State<'_, DbState>,
) -> Result<u32, String> {
    let contenido =
        fs::read_to_string(&ruta_archivo).map_err(|e| format!("Error leyendo archivo: {}", e))?;

    let export: HorarioExport =
        serde_json::from_str(&contenido).map_err(|_| {
            "El archivo no es un horario de EstudIO válido (.json)".to_string()
        })?;

    if export.app != "EstudIO" {
        return Err("El archivo no es un horario de EstudIO válido (.json)".to_string());
    }

    let db = state.db.lock().unwrap();

    if reemplazar {
        db.execute("DELETE FROM SLOTSHORARIO", [])
            .map_err(|e| format!("Error borrando horario previo: {}", e))?;
    }

    let mut insertados: u32 = 0;
    for slot in &export.slots {
        if slot.hora_fin <= slot.hora_inicio {
            eprintln!("Slot inválido (fin <= inicio), se omite: {}", slot.titulo);
            continue;
        }
        if slot.dia_semana > 6 {
            eprintln!("Dia inválido ({}), se omite: {}", slot.dia_semana, slot.titulo);
            continue;
        }
        db.execute(
            "INSERT INTO SLOTSHORARIO (titulo, dia_semana, hora_inicio, hora_fin, color, aula) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                slot.titulo,
                slot.dia_semana,
                slot.hora_inicio,
                slot.hora_fin,
                slot.color,
                slot.aula
            ],
        )
        .map_err(|e| format!("Error insertando slot '{}': {}", slot.titulo, e))?;
        insertados += 1;
    }

    Ok(insertados)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db = inicio(app);
            app.manage(DbState { db: Mutex::new(db) });

            // Chequeo de actualizaciones en hilo async (no bloqueante)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = check_for_updates(handle).await {
                    eprintln!("[updater] Error al verificar actualizaciones: {e}");
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            crear_zip,
            extraer_zip,
            instalar_actualizacion,
            crear_slot_horario,
            borrar_slot_horario,
            mostrar_slots_horario,
            borrar_todos_slots,
            exportar_horario,
            importar_horario,
            cambiar_sincronizar_drive,
            google_drive::iniciar_sesion_google,
            google_drive::desconectar_google,
            google_drive::obtener_estado_google,
            google_drive::guardar_config_google,
            google_drive::obtener_config_google,
            google_drive::subir_apunte_drive,
            google_drive::listar_apuntes_drive,
            google_drive::descargar_apunte_drive,
            google_drive::sincronizar_apuntes_registrados,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Verifica si existe una nueva versión disponible en GitHub Releases.
/// Si la hay, emite el evento "update-available" al frontend con la versión.
async fn check_for_updates(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        app.emit("update-available", update.version.clone())
            .unwrap_or_else(|e| eprintln!("[updater] Error emitiendo evento: {e}"));
    }
    Ok(())
}

/// Descarga e instala la actualización disponible y reinicia la app.
#[tauri::command]
async fn instalar_actualizacion(app: tauri::AppHandle) -> std::result::Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update
            .download_and_install(|_downloaded, _total| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}
