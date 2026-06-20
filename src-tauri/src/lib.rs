mod estructuras;
use estructuras::{Apunte, Materia};
use rusqlite::{Connection, Result};
use std::fs;
use std::fs::File;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

struct DbState {
    db: Mutex<Connection>,
}

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

fn inicio() -> Connection {
    let conexion = Connection::open("../mi_DB.db3").expect("error conectando a sqlite");
    conexion
        .execute(
            "CREATE TABLE IF NOT EXISTS MATERIA (
                    codigo INTEGER PRIMARY KEY,
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
                codigo_apunte INTEGER PRIMARY KEY,
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
    let db = state.db.lock().unwrap();
    if ano < 1 || ano > 5 {
        return Err("Año inválido. Debe ser entre 1 y 5.".to_string());
    }
    if cuatrimestre != 1 && cuatrimestre != 2 && cuatrimestre != 0 {
        return Err("Cuatrimestre inválido. Debe ser 1 o 2.".to_string());
    }
    let nombre = sanitize_filename(&nombre);

    let next_id: usize = db
        .query_row(
            "SELECT IFNULL(MAX(CAST(codigo AS INTEGER)), 0) FROM MATERIA",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let new_id = if next_id == 0 { 1 } else { next_id + 1 };
    let id = new_id as u32;

    let mat = Materia {
        codigo: id,
        nombre,
        ano,
        cuatrimestre,
        anual,
    };

    db.execute(
        "INSERT INTO MATERIA (codigo, nombre, ano, cuatrimestre, anual) VALUES (?1, ?2, ?3, ?4, ?5)",
        (&mat.codigo, &mat.nombre, mat.ano, mat.cuatrimestre, mat.anual),
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
) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    let tema = sanitize_filename(&tema);
    let materia_codigo = materia_codigo.parse::<u32>().unwrap();
    let db_has_materias: usize = db
        .query_row("SELECT COUNT(*) FROM MATERIA", [], |row| row.get(0))
        .unwrap_or(0);
    if db_has_materias == 0 {
        return Err("No hay materias registradas!!!".to_string());
    }
    let next_id: usize = db
        .query_row(
            "SELECT IFNULL(MAX(CAST(codigo_apunte AS INTEGER)), 0) FROM APUNTE",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let new_id = if next_id == 0 { 1 } else { next_id + 1 };
    let codigo_apunte = new_id as u32;

    let nombre_archivo = format!("{}.md", tema);
    let ruta_completa = Path::new(&ruta).join(nombre_archivo);
    let _ = File::create(&ruta_completa).map_err(|e| format!("Error creando el archivo: {}", e))?;
    let ruta = ruta_completa.to_str().unwrap(); //Se guarda la ruta completa, facilita la apertura

    db.execute(
        "INSERT INTO APUNTE (codigo_apunte, tema, materia_codigo, fecha_creacion, ruta, ult_modificacion) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (&codigo_apunte, &tema, &materia_codigo, &fecha_creacion, &ruta, &ult_modificacion),
    )
    .map_err(|e| format!("Error registrando el apunte: {}", e))?;
    Ok("Apunte registrado exitosamente.".to_string())
}

#[tauri::command]
fn mostrar_ult_modif(state: State<'_, DbState>) -> Result<Vec<Apunte>, String> {
    let db = state.db.lock().unwrap();
    let mut apuntes_consulta = db
        .prepare("SELECT tema, ult_modificacion FROM APUNTE ORDER BY ult_modificacion DESC LIMIT 5")
        .map_err(|e| format!("No es posible crear el statement: {}", e))?;
    let iterador = apuntes_consulta
        .query_map([], |registro| {
            Ok(Apunte {
                tema: registro.get(0)?,
                ult_modificacion: registro.get(1)?,
                codigo_apunte: 0,
                materia_codigo: 0,
                fecha_creacion: "".to_string(),
                ruta: "".to_string(),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = inicio();

    tauri::Builder::default()
        .manage(DbState { db: Mutex::new(db) })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            crear_materia,
            mostrar_materias,
            crear_apunte,
            mostrar_ult_modif,
            buscar_apunt_materia,
            abrir_apunte,
            guardar_apunte,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
