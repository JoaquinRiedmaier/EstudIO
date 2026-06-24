use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Materia {
    pub codigo: u32,
    pub nombre: String,
    pub ano: u8,
    pub cuatrimestre: u8,
    pub anual: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Apunte {
    pub codigo_apunte: u32,
    pub materia_codigo: u32,
    pub fecha_creacion: String,
    pub ult_modificacion: String,
    pub tema: String,
    pub ruta: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Evento {
    pub codigo_evento: u32,     // Identificador
    pub fecha: String,          //Obligatorio, importante para recordarle al usuario
    pub hora: String,           //Opcional
    pub fecha_recordar: String, // Cuanto antes? semana, dia mes?
    pub nombre: String,         //Obligatorio
    pub descripcion: String,    //Opcional
}
