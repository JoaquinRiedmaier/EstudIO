mod estructuras;
use estructuras::Materia;

use rusqlite::{Connection, Result};
use std::sync::Mutex;
use tauri::State;

struct DbState {
    db: Mutex<Connection>,
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' => '_',
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

    db.execute(
        "INSERT INTO APUNTE (codigo_apunte, tema, materia_codigo, fecha_creacion, ruta, ult_modificacion) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (&codigo_apunte, &tema, &materia_codigo, &fecha_creacion, &ruta, &ult_modificacion),
    )
    .map_err(|e| format!("Error registrando el apunte: {}", e))?;

    Ok("Apunte registrado exitosamente.".to_string())
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
            crear_apunte
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
