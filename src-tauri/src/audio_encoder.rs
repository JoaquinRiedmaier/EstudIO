use std::num::{NonZeroU32, NonZeroU8};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};

/// Codifica un vector de muestras Float32 (mono) a un buffer de bytes en formato OGG Vorbis.
/// Calidad 0.15–0.20 optimizada para voz humana mono (bitrate promedio ~28–36 kbps),
/// garantizando que 1 hora de grabación ocupe apenas ~11–14 MB (muy por debajo del límite de 25MB de Groq).
pub fn codificar_pcm_a_ogg(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    if samples.is_empty() {
        return Err("No hay muestras de audio para codificar".to_string());
    }

    let channels = NonZeroU8::new(1).ok_or("Canales inválidos")?;
    let rate = NonZeroU32::new(sample_rate).ok_or("Sample rate inválido")?;

    let mut out_buffer = Vec::new();

    let encoder = VorbisEncoderBuilder::new(
        rate,
        channels,
        &mut out_buffer,
    )
    .map_err(|e| format!("Error creando VorbisEncoderBuilder: {:?}", e))?
    .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
        target_quality: 0.15,
    })
    .build()
    .map_err(|e| format!("Error inicializando VorbisEncoder: {:?}", e))?;

    // Vorbis espera &[&[f32]] donde cada slice interno es un canal
    let channel_data: [&[f32]; 1] = [samples];
    let mut encoder = encoder;
    encoder
        .encode_audio_block(&channel_data)
        .map_err(|e| format!("Error codificando audio block: {:?}", e))?;

    encoder
        .finish()
        .map_err(|e| format!("Error finalizando codificación OGG: {:?}", e))?;

    Ok(out_buffer)
}

/// Asegura que los bytes recibidos se almacenen como un archivo OGG mono comprimido.
/// Si el input es OGG nativo, lo mantiene.
/// Si el input es WAV PCM (generado por fallback WebAudio), lo decodifica y transcodifica a OGG Vorbis.
pub fn asegurar_formato_ogg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    // 1. Si ya es OggS (Magic Bytes [0x4F, 0x67, 0x67, 0x53])
    if bytes.len() >= 4 && &bytes[0..4] == b"OggS" {
        return Ok(bytes.to_vec());
    }

    // 2. Si es formato WAV (RIFF .... WAVE)
    if bytes.len() > 44 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        let num_channels = u16::from_le_bytes([bytes[22], bytes[23]]);
        let sample_rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
        let bits_per_sample = u16::from_le_bytes([bytes[34], bytes[35]]);

        // Buscar subchunk "data"
        let mut data_offset = 36;
        while data_offset + 8 <= bytes.len() {
            if &bytes[data_offset..data_offset + 4] == b"data" {
                data_offset += 8; // saltar "data" + u32 longitud
                break;
            }
            data_offset += 1;
        }

        if data_offset >= bytes.len() {
            data_offset = 44; // fallback al header canónico
        }

        let mut samples_mono: Vec<f32> = Vec::new();

        if bits_per_sample == 16 {
            let pcm_bytes = &bytes[data_offset..];
            let _total_samples = pcm_bytes.len() / 2;
            let mut i = 0;
            while i + 1 < pcm_bytes.len() {
                let sample_val = i16::from_le_bytes([pcm_bytes[i], pcm_bytes[i + 1]]);
                let sample_f32 = (sample_val as f32) / 32768.0;
                samples_mono.push(sample_f32);
                i += 2;
            }

            // Si tenía más de 1 canal, convertir a mono promediando
            if num_channels > 1 {
                let channels = num_channels as usize;
                let mono_len = samples_mono.len() / channels;
                let mut downmixed = Vec::with_capacity(mono_len);
                for frame in 0..mono_len {
                    let mut sum = 0.0;
                    for ch in 0..channels {
                        sum += samples_mono[frame * channels + ch];
                    }
                    downmixed.push(sum / channels as f32);
                }
                samples_mono = downmixed;
            }
        } else {
            return Err(format!("Formato de bits por muestra no soportado: {}", bits_per_sample));
        }

        eprintln!(
            "[audio_encoder] Transcodificando WAV PCM ({}, {}Hz, {} muestras) a OGG Vorbis Mono...",
            if num_channels == 1 { "mono" } else { "stereo" },
            sample_rate,
            samples_mono.len()
        );

        return codificar_pcm_a_ogg(&samples_mono, sample_rate);
    }

    // 3. Si no es reconocido, devolver error
    Err("Formato de audio no reconocido para conversión a OGG".to_string())
}
