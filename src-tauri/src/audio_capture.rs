//! Captura de audio nativa con cpal.
//!
//! Reemplaza al camino por `getUserMedia` + WebAudio del webview. Hablar directamente con
//! ALSA/PipeWire (Linux), WASAPI (Windows) o CoreAudio (macOS) evita de raíz los problemas
//! del motor embebido: el `MediaRecorder` que devolvía cero bytes en WebKitGTK, la mezcla a
//! mono que se quedaba con el canal equivocado, el diálogo de permiso de cámara que
//! disparaba la enumeración de dispositivos, y el envío del audio entero por IPC.
//!
//! El PCM queda en memoria como muestras entrelazadas de 16 bits, tal cual lo entrega el
//! dispositivo: la reducción a mono la decide después el encoder, que puede medir cada canal
//! sobre la grabación completa.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Formatos de muestra en orden de preferencia.
///
/// Se pide `I16` antes que nada, aunque el dispositivo declare otro por defecto. Además de
/// ser el formato que usa el encoder —con lo que ahorra una conversión—, esquiva un fallo
/// del backend ALSA de cpal 0.18: en streams `F32` entrega solo la mitad de las muestras de
/// cada período. Medido sobre un mismo dispositivo: 47.784 muestras/s en F32 contra 95.571
/// en I16, con 96.000 esperadas. Grabar con ese fallo da audio a media duración, sin ningún
/// error que lo delate.
const FORMATOS_PREFERIDOS: [SampleFormat; 7] = [
    SampleFormat::I16,
    SampleFormat::I32,
    SampleFormat::I8,
    SampleFormat::U16,
    SampleFormat::U8,
    SampleFormat::F32,
    SampleFormat::F64,
];

/// Si se captura menos de esta fracción del audio esperado, algo se está perdiendo.
const FRACCION_MINIMA_ESPERADA: f64 = 0.85;

/// Datos compartidos entre el callback de audio y el resto de la aplicación.
struct Compartido {
    muestras: Mutex<Vec<i16>>,
    /// Pico del bloque más reciente, en valor absoluto de 16 bits. Lo escribe el callback
    /// de audio, así que tiene que ser una operación que no bloquee.
    pico: AtomicU32,
    detener: AtomicBool,
}

/// Una grabación en curso.
pub struct Captura {
    compartido: Arc<Compartido>,
    hilo: Option<JoinHandle<()>>,
    pub canales: u16,
    pub sample_rate: u32,
    pub dispositivo: String,
    inicio: std::time::Instant,
}

/// Lo que el frontend necesita saber al arrancar.
#[derive(Debug, Clone, serde::Serialize)]
pub struct InfoCaptura {
    pub dispositivo: String,
    pub canales: u16,
    pub sample_rate: u32,
}

impl Captura {
    /// Abre el dispositivo de entrada predeterminado del sistema y empieza a grabar.
    ///
    /// No se fija ningún dispositivo concreto a propósito: se usa el default, que es el que
    /// el usuario ya tiene configurado y el único que existe con seguridad en otra máquina.
    pub fn iniciar() -> Result<Self, String> {
        let compartido = Arc::new(Compartido {
            muestras: Mutex::new(Vec::new()),
            pico: AtomicU32::new(0),
            detener: AtomicBool::new(false),
        });

        // `cpal::Stream` no es `Send`, así que se construye y se destruye dentro del hilo
        // que lo posee; el resultado de la apertura vuelve por un canal.
        let (tx, rx) = mpsc::channel::<Result<InfoCaptura, String>>();
        let compartido_hilo = compartido.clone();

        let hilo = thread::spawn(move || {
            let abierto = abrir_stream(&compartido_hilo);

            let (stream, info) = match abierto {
                Ok(par) => par,
                Err(e) => {
                    let _ = tx.send(Err(e));
                    return;
                }
            };

            if let Err(e) = stream.play() {
                let _ = tx.send(Err(format!("No se pudo iniciar la captura de audio: {e}")));
                return;
            }

            eprintln!(
                "[captura] Grabando desde '{}' — {} canal/es a {} Hz",
                info.dispositivo, info.canales, info.sample_rate
            );
            let _ = tx.send(Ok(info));

            while !compartido_hilo.detener.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(40));
            }

            drop(stream);
        });

        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(info)) => Ok(Self {
                compartido,
                hilo: Some(hilo),
                canales: info.canales,
                sample_rate: info.sample_rate,
                dispositivo: info.dispositivo,
                inicio: std::time::Instant::now(),
            }),
            Ok(Err(e)) => {
                let _ = hilo.join();
                Err(e)
            }
            Err(_) => {
                compartido.detener.store(true, Ordering::Relaxed);
                let _ = hilo.join();
                Err("El dispositivo de audio no respondió a tiempo.".to_string())
            }
        }
    }

    pub fn info(&self) -> InfoCaptura {
        InfoCaptura {
            dispositivo: self.dispositivo.clone(),
            canales: self.canales,
            sample_rate: self.sample_rate,
        }
    }

    /// Pico del bloque más reciente, en escala [0, 1]. Alimenta el medidor de la interfaz.
    pub fn pico(&self) -> f32 {
        self.compartido.pico.load(Ordering::Relaxed) as f32 / 32768.0
    }

    /// Segundos grabados hasta el momento.
    pub fn duracion_segundos(&self) -> u32 {
        let muestras = self.compartido.muestras.lock().map(|m| m.len()).unwrap_or(0);
        let por_segundo = self.sample_rate as usize * self.canales.max(1) as usize;
        if por_segundo == 0 {
            0
        } else {
            (muestras / por_segundo) as u32
        }
    }

    /// Detiene la captura y devuelve el PCM entrelazado.
    pub fn finalizar(mut self) -> Vec<i16> {
        let transcurrido = self.inicio.elapsed().as_secs_f64();

        self.compartido.detener.store(true, Ordering::Relaxed);
        if let Some(hilo) = self.hilo.take() {
            let _ = hilo.join();
        }

        let muestras: Vec<i16> = self
            .compartido
            .muestras
            .lock()
            .map(|mut m| std::mem::take(&mut *m))
            .unwrap_or_default();

        // Red de seguridad contra backends que entregan menos muestras de las que declaran:
        // sin esto el audio sale a media duración y nada lo delata hasta leer la
        // transcripción. Comparamos lo capturado contra el tiempo real de grabación.
        let frames = muestras.len() / self.canales.max(1) as usize;
        let esperados = transcurrido * self.sample_rate as f64;
        if esperados > 1.0 {
            let fraccion = frames as f64 / esperados;
            if fraccion < FRACCION_MINIMA_ESPERADA {
                eprintln!(
                    "[captura] ADVERTENCIA: se capturó el {:.0}% del audio esperado \
                     ({:.1}s de {:.1}s). El backend de audio está descartando muestras.",
                    fraccion * 100.0,
                    frames as f64 / self.sample_rate as f64,
                    transcurrido
                );
            }
        }

        muestras
    }
}

impl Drop for Captura {
    fn drop(&mut self) {
        // Si la captura se descarta sin finalizar (cancelación o cierre), el hilo tiene que
        // enterarse igual para soltar el dispositivo.
        self.compartido.detener.store(true, Ordering::Relaxed);
        if let Some(hilo) = self.hilo.take() {
            let _ = hilo.join();
        }
    }
}

fn abrir_stream(compartido: &Arc<Compartido>) -> Result<(cpal::Stream, InfoCaptura), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No se encontró ningún dispositivo de entrada de audio en el sistema.")?;

    let dispositivo = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "dispositivo predeterminado".to_string());

    let soportado = device
        .default_input_config()
        .map_err(|e| format!("No se pudo consultar la configuración del micrófono: {e}"))?;

    let config: cpal::StreamConfig = soportado.into();

    let info = InfoCaptura {
        dispositivo,
        canales: config.channels,
        sample_rate: config.sample_rate,
    };

    // Se conservan los canales y la frecuencia del dispositivo, pero el formato de muestra
    // lo elegimos nosotros por orden de preferencia (ver FORMATOS_PREFERIDOS).
    let mut ultimo_error: Option<cpal::Error> = None;
    for formato in FORMATOS_PREFERIDOS {
        let intento = match formato {
            SampleFormat::I16 => construir::<i16>(&device, config.clone(), compartido),
            SampleFormat::I32 => construir::<i32>(&device, config.clone(), compartido),
            SampleFormat::I8 => construir::<i8>(&device, config.clone(), compartido),
            SampleFormat::U16 => construir::<u16>(&device, config.clone(), compartido),
            SampleFormat::U8 => construir::<u8>(&device, config.clone(), compartido),
            SampleFormat::F32 => construir::<f32>(&device, config.clone(), compartido),
            _ => construir::<f64>(&device, config.clone(), compartido),
        };

        match intento {
            Ok(stream) => {
                eprintln!("[captura] Formato de muestra negociado: {formato}");
                return Ok((stream, info));
            }
            Err(e) => ultimo_error = Some(e),
        }
    }

    Err(match ultimo_error {
        Some(e) => format!("No se pudo abrir el micrófono: {e}"),
        None => "No se pudo abrir el micrófono con ningún formato soportado.".to_string(),
    })
}

fn construir<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    compartido: &Arc<Compartido>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    i16: FromSample<T>,
{
    let destino = compartido.clone();

    device.build_input_stream::<T, _, _>(
        config,
        move |datos: &[T], _: &cpal::InputCallbackInfo| {
            let mut pico = 0u32;

            // El bloqueo es de facto libre de contención: nadie más toca el buffer hasta
            // que la grabación termina.
            if let Ok(mut buffer) = destino.muestras.lock() {
                buffer.reserve(datos.len());
                for muestra in datos {
                    let v = i16::from_sample(*muestra);
                    let abs = (v as i32).unsigned_abs();
                    if abs > pico {
                        pico = abs;
                    }
                    buffer.push(v);
                }
            }

            destino.pico.store(pico, Ordering::Relaxed);
        },
        |err| eprintln!("[captura] Error en el stream de audio: {err}"),
        None,
    )
}
