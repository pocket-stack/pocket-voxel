//! Canonical RIFF/WAVE output for the chip synth's PCM.
//!
//! The shape is the one `contracts/spec/audio.ts` pins for pak WAV entries
//! (PCM, 16-bit, interleaved, a rate in AUDIO_RATES), so the same bytes also
//! load through `framework/src/audio-api.ts` decodeWav.

/// A 44-byte header plus the interleaved s16 frames.
pub fn encode(pcm: &[i16], rate: u32, channels: u16) -> Vec<u8> {
    let data_bytes = pcm.len() * 2;
    let mut out = Vec::with_capacity(44 + data_bytes);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&(channels * 2).to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for sample in pcm {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// Peak and RMS, absolute and as a fraction of full scale. "It renders" and
/// "it is audible" are two different claims and this is what separates them.
pub fn levels(pcm: &[i16]) -> (i32, f64, f64, f64) {
    let mut peak = 0i32;
    let mut sum = 0f64;
    for &v in pcm {
        let a = (v as i32).abs();
        if a > peak {
            peak = a;
        }
        sum += (v as f64) * (v as f64);
    }
    let rms = if pcm.is_empty() {
        0.0
    } else {
        (sum / pcm.len() as f64).sqrt()
    };
    (peak, rms, peak as f64 / 32767.0, rms / 32767.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_is_the_canonical_44_bytes() {
        let out = encode(&[0i16; 8], 11025, 2);
        assert_eq!(out.len(), 44 + 16);
        assert_eq!(&out[0..4], b"RIFF");
        assert_eq!(&out[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(out[24..28].try_into().unwrap()), 11025);
        assert_eq!(u32::from_le_bytes(out[40..44].try_into().unwrap()), 16);
    }

    #[test]
    fn levels_separate_renders_from_audible() {
        let (peak, rms, peak_pct, _) = levels(&[0, 0, 0, 0]);
        assert_eq!(peak, 0);
        assert_eq!(rms, 0.0);
        assert_eq!(peak_pct, 0.0);
        let (peak, rms, peak_pct, _) = levels(&[32767, -32767, 32767, -32767]);
        assert_eq!(peak, 32767);
        assert!((rms - 32767.0).abs() < 1.0);
        assert!((peak_pct - 1.0).abs() < 1e-6);
    }
}
