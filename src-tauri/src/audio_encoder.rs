//! Codificación del audio grabado antes de subirlo a Groq.
//!
//! Recibe el PCM entrelazado tal como lo entrega el micrófono (ver [`crate::audio_capture`])
//! y lo procesa por bloques: elegir canal → normalizar nivel → remuestrear a 16 kHz →
//! codificar en OGG Vorbis. Trabajar por bloques evita materializar la grabación entera en
//! `Vec<f32>` intermedios de cientos de MB; el pico queda en unos pocos buffers reutilizados.

use std::num::{NonZeroU32, NonZeroU8};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};

/// Whisper remuestrea todo a 16 kHz antes de inferir, así que codificar por encima de ese
/// valor gasta CPU y bytes sin aportar nada a la transcripción.
pub const SAMPLE_RATE_OBJETIVO: u32 = 16_000;

/// Límite de subida de la API de Groq (25 MB). Avisamos algo antes por el overhead del multipart.
pub const LIMITE_GROQ_BYTES: usize = 24 * 1024 * 1024;

/// Calidad VBR de Vorbis. A 16 kHz mono ronda los ~30 kbps, con lo que una hora de grabación
/// queda holgadamente por debajo del límite de Groq.
const CALIDAD_VORBIS: f32 = 0.3;

/// Frames de WAV que se decodifican por iteración del pipeline.
const BLOQUE_FRAMES: usize = 16_384;

/// Nivel RMS al que se lleva la señal antes de codificar (-20 dBFS), el rango en el que
/// Whisper rinde mejor. Sin esto, un micrófono con el volumen de captura bajo produce una
/// señal que Vorbis descarta casi entera por inaudible y la transcripción alucina.
const RMS_OBJETIVO: f32 = 0.1;

/// Techo de pico tras normalizar (-1 dBFS), para no recortar.
const PICO_MAXIMO: f32 = 0.89;

/// Ganancia máxima (+40 dB): más que esto solo amplificaría el ruido de fondo.
const GANANCIA_MAXIMA: f32 = 100.0;

/// Por debajo de este pico (≈ -70 dBFS) damos la grabación por muda.
const PICO_SILENCIO: f32 = 0.0003;

/// Amplitud a partir de la cual una muestra se cuenta como recortada.
const UMBRAL_RECORTE: f32 = 0.998;

/// Fracción de muestras recortadas que se considera saturación audible.
const RECORTE_AVISO: f32 = 0.001;

/// Diferencia de nivel a partir de la cual se considera que un canal lleva toda la señal y
/// el resto está mudo. Es el caso habitual del micrófono interno de un portátil: el sistema
/// lo expone como estéreo pero la cápsula real está cableada a un solo canal, y promediar
/// con el canal muerto mete ruido y pierde 6 dB — o directamente graba silencio si alguien
/// más arriba en la cadena se queda con el canal equivocado.
const DOMINANCIA_CANAL_DB: f32 = 12.0;

/// Audio listo para persistir en disco y subir a Groq.
pub struct AudioPreparado {
    pub bytes: Vec<u8>,
    pub extension: &'static str,
    pub mime: &'static str,
}

/// Convierte el PCM capturado en un OGG Vorbis mono listo para transcribir.
pub fn preparar_pcm(
    muestras: &[i16],
    canales: usize,
    sample_rate: u32,
) -> Result<AudioPreparado, String> {
    let preparado = AudioPreparado {
        bytes: codificar_pcm_a_ogg(muestras, canales, sample_rate)?,
        extension: "ogg",
        mime: "audio/ogg",
    };

    if preparado.bytes.len() > LIMITE_GROQ_BYTES {
        eprintln!(
            "[audio_encoder] Advertencia: el audio pesa {:.1} MB y supera el límite de subida de Groq (25 MB).",
            preparado.bytes.len() as f64 / (1024.0 * 1024.0)
        );
    }

    Ok(preparado)
}

/// MIME que corresponde a la extensión con la que se guardó la grabación.
pub fn mime_por_extension(ruta: &str) -> &'static str {
    match ruta
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "webm" => "audio/webm",
        "m4a" | "mp4" => "audio/mp4",
        "wav" => "audio/wav",
        _ => "audio/ogg",
    }
}

// ─── Reducción a mono, normalización y codificación ──────────────────────────

/// Cómo se reduce a mono una grabación con varios canales.
#[derive(Debug, Clone, Copy, PartialEq)]
enum EstrategiaMono {
    /// Un solo canal lleva la señal; los demás están mudos y solo aportarían ruido.
    Canal(usize),
    /// Todos los canales aportan: se promedian.
    Promedio,
}

/// Nivel de una señal: pico y RMS en escala normalizada [0, 1].
#[derive(Debug, Clone, Copy, Default)]
struct Nivel {
    pico: f32,
    rms: f32,
    /// Fracción de muestras pegadas al fondo de escala: señal de que la entrada satura.
    recorte: f32,
}

struct AnalisisCanales {
    /// Nivel de cada canal por separado.
    por_canal: Vec<Nivel>,
    /// Nivel del promedio de todos los canales.
    promedio: Nivel,
}

fn a_dbfs(x: f32) -> f32 {
    20.0 * x.max(1e-12).log10()
}

/// Recorre el PCM una sola vez midiendo cada canal y la mezcla promediada.
fn analizar_canales(muestras: &[i16], canales: usize) -> AnalisisCanales {
    let inv_canales = 1.0 / canales as f32;
    let mut picos = vec![0.0f32; canales];
    let mut sumas = vec![0.0f64; canales];
    let mut recortes = vec![0u64; canales];
    let mut pico_prom = 0.0f32;
    let mut suma_prom = 0.0f64;
    let mut recorte_prom = 0u64;
    let mut n = 0u64;

    for frame in muestras.chunks_exact(canales) {
        let mut acc = 0.0f32;
        for (c, muestra) in frame.iter().enumerate() {
            let v = *muestra as f32 / 32768.0;
            let abs = v.abs();
            if abs > picos[c] {
                picos[c] = abs;
            }
            sumas[c] += (v as f64) * (v as f64);
            if abs >= UMBRAL_RECORTE {
                recortes[c] += 1;
            }
            acc += v;
        }

        let m = acc * inv_canales;
        let abs = m.abs();
        if abs > pico_prom {
            pico_prom = abs;
        }
        suma_prom += (m as f64) * (m as f64);
        if abs >= UMBRAL_RECORTE {
            recorte_prom += 1;
        }
        n += 1;
    }

    let raiz = |suma: f64| if n > 0 { (suma / n as f64).sqrt() as f32 } else { 0.0 };
    let fraccion = |c: u64| if n > 0 { c as f32 / n as f32 } else { 0.0 };

    AnalisisCanales {
        por_canal: (0..canales)
            .map(|c| Nivel {
                pico: picos[c],
                rms: raiz(sumas[c]),
                recorte: fraccion(recortes[c]),
            })
            .collect(),
        promedio: Nivel {
            pico: pico_prom,
            rms: raiz(suma_prom),
            recorte: fraccion(recorte_prom),
        },
    }
}

/// Si un canal supera al resto por un margen amplio, el resto está mudo y hay que
/// descartarlo en vez de promediarlo.
fn elegir_estrategia(por_canal: &[Nivel]) -> EstrategiaMono {
    if por_canal.len() < 2 {
        return EstrategiaMono::Canal(0);
    }

    let mejor = por_canal
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.rms.total_cmp(&b.rms))
        .map(|(i, _)| i)
        .unwrap_or(0);

    let resto = por_canal
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != mejor)
        .map(|(_, n)| n.rms)
        .fold(0.0f32, f32::max);

    if a_dbfs(por_canal[mejor].rms) - a_dbfs(resto) >= DOMINANCIA_CANAL_DB {
        EstrategiaMono::Canal(mejor)
    } else {
        EstrategiaMono::Promedio
    }
}

/// Ganancia que lleva la señal al nivel objetivo sin recortar.
///
/// Solo amplifica: una grabación que ya viene con buen nivel se deja intacta, porque
/// atenuarla no aportaría nada y un recorte previo no se puede deshacer.
fn calcular_ganancia(pico: f32, rms: f32) -> f32 {
    if rms <= 0.0 || pico <= 0.0 {
        return 1.0;
    }
    (RMS_OBJETIVO / rms)
        .min(PICO_MAXIMO / pico)
        .clamp(1.0, GANANCIA_MAXIMA)
}

/// PCM entrelazado de 16 bits → OGG Vorbis mono a 16 kHz.
pub fn codificar_pcm_a_ogg(
    muestras: &[i16],
    canales: usize,
    sample_rate: u32,
) -> Result<Vec<u8>, String> {
    if canales == 0 {
        return Err("La grabación no declara ningún canal de audio".to_string());
    }
    if sample_rate == 0 {
        return Err("La grabación no declara una frecuencia de muestreo válida".to_string());
    }

    let total_frames = muestras.len() / canales;
    if total_frames == 0 {
        return Err("La grabación no contiene muestras de audio".to_string());
    }
    // Descartamos un frame incompleto al final, si lo hubiera.
    let datos = &muestras[..total_frames * canales];

    // Nunca sobremuestreamos: si la fuente ya está por debajo de 16 kHz no hay nada que ganar.
    let rate_salida = SAMPLE_RATE_OBJETIVO.min(sample_rate);
    let mut remuestreador = if sample_rate == rate_salida {
        None
    } else {
        Some(Remuestreador::nuevo(sample_rate, rate_salida))
    };

    let segundos = total_frames as f64 / sample_rate as f64;

    // Una pasada previa para conocer el nivel de cada canal: es barata comparada con la
    // codificación, y permite tanto descartar canales mudos como normalizar la señal antes
    // de que Vorbis decida qué información tirar por inaudible.
    let analisis = analizar_canales(datos, canales);
    let estrategia = elegir_estrategia(&analisis.por_canal);

    let Nivel { pico, rms, recorte } = match estrategia {
        EstrategiaMono::Canal(c) => analisis.por_canal[c],
        EstrategiaMono::Promedio => analisis.promedio,
    };

    if recorte > RECORTE_AVISO {
        eprintln!(
            "[audio_encoder] ADVERTENCIA: el {:.1}% de las muestras satura. El volumen de \
             captura del sistema está demasiado alto y la distorsión degrada la transcripción.",
            recorte * 100.0
        );
    }

    if canales > 1 {
        let detalle: Vec<String> = analisis
            .por_canal
            .iter()
            .enumerate()
            .map(|(i, n)| format!("ch{} {:.1} dBFS", i, a_dbfs(n.rms)))
            .collect();
        match estrategia {
            EstrategiaMono::Canal(c) => eprintln!(
                "[audio_encoder] Canales: {} — se usa solo el canal {}, el resto está mudo.",
                detalle.join(", "),
                c
            ),
            EstrategiaMono::Promedio => eprintln!(
                "[audio_encoder] Canales: {} — se promedian todos.",
                detalle.join(", ")
            ),
        }
    }

    if pico < PICO_SILENCIO {
        return Err(
            "La grabación está en silencio: el micrófono no capturó sonido. Revisá que no esté \
             silenciado y que tenga volumen de captura."
                .to_string(),
        );
    }

    let ganancia = calcular_ganancia(pico, rms);

    eprintln!(
        "[audio_encoder] Codificando {} canal/es a {} Hz ({:.0}s) → OGG Vorbis mono {} Hz \
         | pico {:.1} dBFS, RMS {:.1} dBFS, ganancia aplicada {:+.1} dB",
        canales,
        sample_rate,
        segundos,
        rate_salida,
        a_dbfs(pico),
        a_dbfs(rms),
        a_dbfs(ganancia)
    );

    // Reserva aproximada a ~32 kbps para evitar realocaciones del buffer de salida.
    let estimado = (segundos * 4_000.0) as usize;
    let mut salida: Vec<u8> = Vec::with_capacity(estimado.clamp(64 * 1024, 32 * 1024 * 1024));

    {
        let mut encoder = VorbisEncoderBuilder::new(
            NonZeroU32::new(rate_salida).ok_or("Frecuencia de salida inválida")?,
            NonZeroU8::new(1).ok_or("Cantidad de canales inválida")?,
            &mut salida,
        )
        .map_err(|e| format!("Error creando VorbisEncoderBuilder: {:?}", e))?
        .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
            target_quality: CALIDAD_VORBIS,
        })
        .build()
        .map_err(|e| format!("Error inicializando VorbisEncoder: {:?}", e))?;

        let inv_canales = 1.0 / canales as f32; // solo lo usa la rama del promedio

        let mut mono: Vec<f32> = Vec::with_capacity(BLOQUE_FRAMES);
        let mut bloque: Vec<f32> = Vec::with_capacity(BLOQUE_FRAMES);

        let mut frame = 0usize;
        while frame < total_frames {
            let n = BLOQUE_FRAMES.min(total_frames - frame);
            let trozo = &datos[frame * canales..(frame + n) * canales];

            // Reducción a mono y normalización en una sola pasada, sin vectores intermedios.
            mono.clear();
            match estrategia {
                EstrategiaMono::Canal(c) => {
                    for cuadro in trozo.chunks_exact(canales) {
                        let v = cuadro[c] as f32 / 32768.0;
                        mono.push((v * ganancia).clamp(-1.0, 1.0));
                    }
                }
                EstrategiaMono::Promedio => {
                    for cuadro in trozo.chunks_exact(canales) {
                        let mut acc = 0.0f32;
                        for muestra in cuadro {
                            acc += *muestra as f32;
                        }
                        mono.push((acc * inv_canales / 32768.0 * ganancia).clamp(-1.0, 1.0));
                    }
                }
            }

            bloque.clear();
            match remuestreador.as_mut() {
                Some(r) => r.procesar(&mono, &mut bloque),
                None => bloque.extend_from_slice(&mono),
            }

            if !bloque.is_empty() {
                encoder
                    .encode_audio_block(&[&bloque[..]])
                    .map_err(|e| format!("Error codificando bloque de audio: {:?}", e))?;
            }

            frame += n;
        }

        // Cola del remuestreador: las últimas muestras que el kernel todavía tenía pendientes.
        if let Some(r) = remuestreador.as_mut() {
            bloque.clear();
            r.finalizar(&mut bloque);
            if !bloque.is_empty() {
                encoder
                    .encode_audio_block(&[&bloque[..]])
                    .map_err(|e| format!("Error codificando el bloque final: {:?}", e))?;
            }
        }

        encoder
            .finish()
            .map_err(|e| format!("Error finalizando la codificación OGG: {:?}", e))?;
    }

    Ok(salida)
}

// ─── Remuestreo ──────────────────────────────────────────────────────────────

/// Fases precalculadas del kernel. Cuantizar la posición fraccionaria a 1/512 de muestra es
/// inaudible y evita evaluar `sin()` una vez por cada muestra de salida, que es lo que haría
/// inviable calcular el sinc al vuelo.
const FASES: usize = 512;

/// Cruces por cero del sinc a cada lado del centro: define el compromiso entre la banda de
/// transición del filtro y la cantidad de taps por muestra de salida.
const CEROS_SINC: usize = 4;

/// Remuestreador polifásico (sinc enventanado con Blackman) que trabaja en streaming:
/// conserva entre llamadas la cola de muestras que el kernel todavía necesita, de modo que
/// el pipeline nunca tiene que ver la grabación completa.
struct Remuestreador {
    kernel: Vec<f32>,
    taps: usize,
    half: usize,
    /// Muestras de entrada que avanza cada muestra de salida.
    paso: f64,
    cola: Vec<f32>,
    /// Índice absoluto, dentro del stream de entrada, de `cola[0]`.
    base: u64,
    n_salida: u64,
    vistas: u64,
}

impl Remuestreador {
    fn nuevo(origen: u32, destino: u32) -> Self {
        // Corte al 90% de la nueva Nyquist: deja margen de transición sin comerse agudos de voz.
        let fc = 0.9 * (destino as f64 / origen as f64).min(1.0);
        let half = (CEROS_SINC as f64 / fc).ceil() as usize;
        let taps = 2 * half + 1;
        let borde = half as f64 + 1.0;

        let mut kernel = vec![0.0f32; FASES * taps];
        for fase in 0..FASES {
            let frac = fase as f64 / FASES as f64;
            let inicio = fase * taps;
            let mut suma = 0.0f64;

            for k in 0..taps {
                // Distancia, en muestras de entrada, entre el tap k y el instante reconstruido.
                let x = frac + half as f64 - k as f64;
                let h = fc * sinc(fc * x) * blackman(x / borde);
                kernel[inicio + k] = h as f32;
                suma += h;
            }

            // Normalizamos cada fase para que la ganancia en continua sea exactamente 1 y el
            // remuestreo no introduzca ondulación de amplitud.
            if suma.abs() > f64::EPSILON {
                for k in 0..taps {
                    kernel[inicio + k] = (kernel[inicio + k] as f64 / suma) as f32;
                }
            }
        }

        Self {
            kernel,
            taps,
            half,
            paso: origen as f64 / destino as f64,
            cola: Vec::new(),
            base: 0,
            n_salida: 0,
            vistas: 0,
        }
    }

    fn procesar(&mut self, entrada: &[f32], salida: &mut Vec<f32>) {
        self.vistas += entrada.len() as u64;
        self.cola.extend_from_slice(entrada);
        self.emitir(salida, false);
    }

    fn finalizar(&mut self, salida: &mut Vec<f32>) {
        self.emitir(salida, true);
    }

    fn emitir(&mut self, salida: &mut Vec<f32>, ultimo: bool) {
        let disponible = (self.base + self.cola.len() as u64) as i64;
        let base = self.base as i64;

        loop {
            let t = self.n_salida as f64 * self.paso;
            let centro = t.floor();
            let idx = centro as i64;

            if ultimo {
                // Al cerrar, emitimos hasta que el centro del kernel pasa el final del stream.
                if t >= self.vistas as f64 {
                    break;
                }
            } else if idx + self.half as i64 >= disponible {
                break; // todavía no llegaron todas las muestras que el kernel necesita
            }

            let fase = (((t - centro) * FASES as f64) as usize).min(FASES - 1);
            let inicio = fase * self.taps;
            let primero = idx - self.half as i64;

            let mut acc = 0.0f32;
            for k in 0..self.taps {
                let abs = primero + k as i64;
                // Fuera del stream (arranque o cola final) la señal vale cero.
                if abs < base || abs >= disponible {
                    continue;
                }
                acc += self.cola[(abs - base) as usize] * self.kernel[inicio + k];
            }

            salida.push(acc);
            self.n_salida += 1;
        }

        // Soltamos las muestras que ningún kernel futuro va a volver a tocar.
        let necesario = (self.n_salida as f64 * self.paso).floor() as i64 - self.half as i64;
        if necesario > base {
            let sobran = ((necesario - base) as usize).min(self.cola.len());
            self.cola.drain(..sobran);
            self.base += sobran as u64;
        }
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let p = std::f64::consts::PI * x;
        p.sin() / p
    }
}

fn blackman(t: f64) -> f64 {
    if t.abs() >= 1.0 {
        return 0.0;
    }
    let p = std::f64::consts::PI * t;
    0.42 + 0.5 * p.cos() + 0.08 * (2.0 * p).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tono(frecuencia: f64, sample_rate: u32, segundos: f64) -> Vec<f32> {
        let n = (sample_rate as f64 * segundos) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / sample_rate as f64;
                (2.0 * std::f64::consts::PI * frecuencia * t).sin() as f32
            })
            .collect()
    }

    fn rms(muestras: &[f32]) -> f32 {
        if muestras.is_empty() {
            return 0.0;
        }
        let suma: f64 = muestras.iter().map(|m| (*m as f64) * (*m as f64)).sum();
        (suma / muestras.len() as f64).sqrt() as f32
    }

    /// Descarta los bordes, donde el kernel todavía se apoya en ceros fuera del stream.
    fn nucleo(muestras: &[f32]) -> &[f32] {
        let margen = muestras.len() / 10;
        &muestras[margen..muestras.len() - margen]
    }

    /// Convierte una señal en [-1, 1] a PCM entrelazado de 16 bits.
    fn pcm(canales: &[&[f32]]) -> Vec<i16> {
        let frames = canales.iter().map(|c| c.len()).min().unwrap_or(0);
        let mut salida = Vec::with_capacity(frames * canales.len());
        for i in 0..frames {
            for canal in canales {
                salida.push((canal[i].clamp(-1.0, 1.0) * 32767.0) as i16);
            }
        }
        salida
    }

    #[test]
    fn remuestreo_conserva_la_banda_de_voz() {
        let entrada = tono(1_000.0, 48_000, 1.0);
        let mut r = Remuestreador::nuevo(48_000, 16_000);
        let mut salida = Vec::new();
        r.procesar(&entrada, &mut salida);
        r.finalizar(&mut salida);

        // Una muestra de salida por cada tres de entrada, con una de tolerancia.
        let esperadas = entrada.len() / 3;
        assert!(
            (salida.len() as i64 - esperadas as i64).abs() <= 1,
            "se esperaban ~{} muestras y salieron {}",
            esperadas,
            salida.len()
        );

        // Un tono de 1 kHz está muy por debajo del corte: debe pasar sin perder energía.
        let ratio = rms(nucleo(&salida)) / rms(nucleo(&entrada));
        assert!(
            (ratio - 1.0).abs() < 0.02,
            "el tono de 1 kHz se atenuó demasiado (ratio {ratio})"
        );
    }

    #[test]
    fn remuestreo_filtra_lo_que_provocaria_aliasing() {
        // 10 kHz no entra en la nueva Nyquist de 8 kHz: sin filtro reaparecería como 6 kHz.
        let entrada = tono(10_000.0, 48_000, 1.0);
        let mut r = Remuestreador::nuevo(48_000, 16_000);
        let mut salida = Vec::new();
        r.procesar(&entrada, &mut salida);
        r.finalizar(&mut salida);

        let ratio = rms(nucleo(&salida)) / rms(nucleo(&entrada));
        assert!(
            ratio < 0.1,
            "el tono fuera de banda no se filtró lo suficiente (ratio {ratio})"
        );
    }

    #[test]
    fn el_streaming_da_el_mismo_resultado_que_una_sola_pasada() {
        let entrada = tono(900.0, 44_100, 0.5);

        let mut completo = Vec::new();
        let mut r1 = Remuestreador::nuevo(44_100, 16_000);
        r1.procesar(&entrada, &mut completo);
        r1.finalizar(&mut completo);

        // Bloques de tamaño irregular, para ejercitar la cola y el recorte entre llamadas.
        let mut troceado = Vec::new();
        let mut r2 = Remuestreador::nuevo(44_100, 16_000);
        let mut i = 0;
        for (n, tam) in [777usize, 1, 4096, 333].iter().cycle().enumerate() {
            let _ = n;
            if i >= entrada.len() {
                break;
            }
            let fin = (i + tam).min(entrada.len());
            r2.procesar(&entrada[i..fin], &mut troceado);
            i = fin;
        }
        r2.finalizar(&mut troceado);

        assert_eq!(completo.len(), troceado.len());
        for (a, b) in completo.iter().zip(troceado.iter()) {
            assert!((a - b).abs() < 1e-6, "divergencia entre pasadas: {a} vs {b}");
        }
    }

    #[test]
    fn amplifica_una_grabacion_con_el_microfono_bajo() {
        // Niveles medidos en un portátil con el volumen de captura al 13%:
        // pico -54,7 dBFS y RMS -66,5 dBFS. Whisper sobre eso devuelve alucinaciones.
        let pico = 10f32.powf(-54.7 / 20.0);
        let rms = 10f32.powf(-66.5 / 20.0);

        let ganancia = calcular_ganancia(pico, rms);
        assert!(
            (ganancia - GANANCIA_MAXIMA).abs() < 0.01,
            "debería aplicar el tope de +40 dB, aplicó {:+.1} dB",
            a_dbfs(ganancia)
        );

        // Tras normalizar la señal queda en un rango que Whisper sí aprovecha, sin recortar.
        assert!(a_dbfs(rms * ganancia) > -30.0, "RMS resultante demasiado bajo");
        assert!(pico * ganancia < 1.0, "el pico normalizado recorta");
    }

    #[test]
    fn no_toca_una_grabacion_con_buen_nivel() {
        // Nivel sano: -20 dBFS de RMS.
        assert_eq!(calcular_ganancia(0.5, 0.1), 1.0);
        // Señal caliente: nunca atenuamos, el recorte previo no se puede deshacer.
        assert_eq!(calcular_ganancia(0.98, 0.3), 1.0);
    }

    #[test]
    fn la_ganancia_nunca_hace_recortar() {
        // Una señal con mucho factor de cresta: el tope lo marca el pico, no el RMS.
        let pico = 0.3f32;
        let rms = 0.001f32;
        let ganancia = calcular_ganancia(pico, rms);
        assert!(pico * ganancia <= PICO_MAXIMO + 1e-6);
    }

    #[test]
    fn una_grabacion_muda_se_rechaza_en_vez_de_subirse() {
        // Silencio digital: mandarlo a Whisper devuelve "Gracias." en lugar de un error.
        let mudo = pcm(&[&vec![0.0f32; 16_000]]);
        match preparar_pcm(&mudo, 1, 16_000) {
            Err(err) => assert!(err.contains("silencio"), "mensaje inesperado: {err}"),
            Ok(_) => panic!("el silencio debería rechazarse"),
        }

        // Ruido por debajo del umbral también cuenta como grabación muda.
        let casi_mudo: Vec<f32> =
            (0..16_000).map(|i| if i % 997 == 0 { 0.0002 } else { 0.0 }).collect();
        assert!(preparar_pcm(&pcm(&[&casi_mudo]), 1, 16_000).is_err());
    }

    #[test]
    fn una_grabacion_floja_si_se_codifica() {
        // Justo por encima del umbral de silencio: debe pasar y salir amplificada.
        let flojo: Vec<f32> = tono(300.0, 16_000, 1.0).iter().map(|m| m * 0.002).collect();
        let preparado = preparar_pcm(&pcm(&[&flojo]), 1, 16_000)
            .expect("una señal floja pero audible debería codificarse");
        assert!(preparado.bytes.starts_with(b"OggS"));
    }

    /// Micrófono interno de portátil: el sistema lo expone como estéreo pero la cápsula
    /// está cableada solo al canal derecho. Medido en un ALC293: L a -57 dBFS (ruido),
    /// R a -32 dBFS (voz), 25,7 dB de diferencia.
    fn canales_de_microfono_interno() -> (Vec<f32>, Vec<f32>) {
        let voz: Vec<f32> = tono(300.0, 16_000, 1.0).iter().map(|m| m * 0.025).collect();
        let ruido: Vec<f32> = (0..voz.len())
            .map(|i| (((i * 2654435761) % 1000) as f32 / 1000.0 - 0.5) * 0.0028)
            .collect();
        (ruido, voz)
    }

    #[test]
    fn descarta_el_canal_mudo_en_vez_de_promediarlo() {
        let (izq, der) = canales_de_microfono_interno();
        let niveles = [
            Nivel { pico: 0.0014, rms: 0.0013, recorte: 0.0 },
            Nivel { pico: 0.025, rms: 0.0177, recorte: 0.0 },
        ];
        assert_eq!(elegir_estrategia(&niveles), EstrategiaMono::Canal(1));

        // Y la grabación completa debe codificarse sin darse por muda.
        let preparado = preparar_pcm(&pcm(&[&izq, &der]), 2, 16_000)
            .expect("con un canal válido no debería considerarse silencio");
        assert!(preparado.bytes.starts_with(b"OggS"));
    }

    #[test]
    fn promedia_cuando_los_dos_canales_traen_senal() {
        // Estéreo real: ambos canales en el mismo orden de magnitud.
        let niveles = [
            Nivel { pico: 0.4, rms: 0.09, recorte: 0.0 },
            Nivel { pico: 0.5, rms: 0.11, recorte: 0.0 },
        ];
        assert_eq!(elegir_estrategia(&niveles), EstrategiaMono::Promedio);
    }

    #[test]
    fn un_canal_mudo_ya_no_arrastra_la_grabacion_al_silencio() {
        // Promediar el canal muerto con el bueno era lo que hundía el nivel ~6 dB y, si
        // alguien se quedaba con el canal equivocado, dejaba la grabación en silencio.
        let (izq, der) = canales_de_microfono_interno();
        let analisis = analizar_canales(&pcm(&[&izq, &der]), 2);

        let elegido = match elegir_estrategia(&analisis.por_canal) {
            EstrategiaMono::Canal(c) => analisis.por_canal[c],
            EstrategiaMono::Promedio => analisis.promedio,
        };

        assert!(
            elegido.rms > analisis.promedio.rms * 1.5,
            "quedarse con el canal bueno debería superar claramente al promedio"
        );
        assert!(elegido.pico > PICO_SILENCIO);
    }

}
