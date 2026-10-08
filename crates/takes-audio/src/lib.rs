//! Audio analysis for the player: a compact waveform overview, the
//! integrated loudness (EBU R128) used to level-match A/B comparisons, and
//! rough tempo and key estimates.

mod music;

use std::fs::File;
use std::path::Path;

use ebur128::{EbuR128, Mode};
use serde::{Deserialize, Serialize};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Number of points in a waveform overview: enough for a full-width player.
pub const WAVEFORM_POINTS: usize = 1600;

/// Frames folded into one fine-grained block while decoding, before the
/// blocks are resampled to [`WAVEFORM_POINTS`] (total length may be unknown
/// up front, e.g. for MP3).
const BLOCK_FRAMES: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported or damaged audio file: {0}")]
    Decode(String),
    #[error("no audio track in the file")]
    NoAudio,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
    /// Peak amplitude per point, 0–255 for 0.0–1.0 (full scale).
    pub peaks: Vec<u8>,
    /// RMS amplitude per point, same scale.
    pub rms: Vec<u8>,
    /// Integrated loudness in LUFS; `None` for silence.
    pub lufs: Option<f64>,
    /// Estimated tempo; `None` without a clear pulse.
    pub bpm: Option<f64>,
    /// Estimated key, e.g. "Am" or "Eb"; `None` when unclear.
    pub key: Option<String>,
}

/// Decodes the whole file and summarizes it.
pub fn analyze(path: &Path) -> Result<Analysis, Error> {
    let decode_err = |e: DecodeError| Error::Decode(e.to_string());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let source = MediaSourceStream::new(Box::new(File::open(path)?), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(decode_err)?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or(Error::NoAudio)?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or(Error::NoAudio)?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(decode_err)?;

    let mut samples: Vec<f32> = Vec::new();
    let mut summary: Option<Summary> = None;
    while let Some(packet) = format.next_packet().map_err(decode_err)? {
        if packet.track_id != track_id {
            continue;
        }
        let buffer = match decoder.decode(&packet) {
            Ok(buffer) => buffer,
            // A damaged packet: skip it like players do.
            Err(DecodeError::DecodeError(_)) => continue,
            Err(e) => return Err(decode_err(e)),
        };
        let spec = buffer.spec();
        let (rate, channels) = (spec.rate(), spec.channels().count());
        if channels == 0 {
            continue;
        }
        samples.resize(buffer.samples_interleaved(), 0.0);
        buffer.copy_to_slice_interleaved(&mut samples);
        let summary = match &mut summary {
            Some(s) => s,
            None => summary.insert(Summary::new(rate, channels)?),
        };
        summary.add(&samples)?;
    }
    summary.ok_or(Error::NoAudio)?.finish()
}

/// Running state while decoding.
struct Summary {
    rate: u32,
    channels: usize,
    meter: EbuR128,
    features: music::Features,
    frames: u64,
    /// Per block: (peak, sum of squares of the mono mix, frames).
    blocks: Vec<(f32, f64, usize)>,
}

impl Summary {
    fn new(rate: u32, channels: usize) -> Result<Self, Error> {
        let meter = EbuR128::new(channels as u32, rate, Mode::I)
            .map_err(|e| Error::Decode(format!("loudness meter: {e}")))?;
        Ok(Self {
            rate,
            channels,
            meter,
            features: music::Features::new(rate),
            frames: 0,
            blocks: Vec::new(),
        })
    }

    fn add(&mut self, interleaved: &[f32]) -> Result<(), Error> {
        // A format change mid-stream (rare) would break the meter; the
        // overview simply keeps using the first stream's layout.
        let usable = interleaved.len() - interleaved.len() % self.channels;
        let interleaved = &interleaved[..usable];
        self.meter
            .add_frames_f32(interleaved)
            .map_err(|e| Error::Decode(format!("loudness meter: {e}")))?;
        for frame in interleaved.chunks_exact(self.channels) {
            let peak = frame.iter().fold(0f32, |m, s| m.max(s.abs()));
            let mono = frame.iter().sum::<f32>() / self.channels as f32;
            self.features.push(mono);
            match self.blocks.last_mut() {
                Some((p, sq, n)) if *n < BLOCK_FRAMES => {
                    *p = p.max(peak);
                    *sq += f64::from(mono * mono);
                    *n += 1;
                }
                _ => self.blocks.push((peak, f64::from(mono * mono), 1)),
            }
        }
        self.frames += (usable / self.channels) as u64;
        Ok(())
    }

    fn finish(self) -> Result<Analysis, Error> {
        let points = WAVEFORM_POINTS.min(self.blocks.len());
        let mut peaks = Vec::with_capacity(points);
        let mut rms = Vec::with_capacity(points);
        for i in 0..points {
            let range =
                &self.blocks[i * self.blocks.len() / points..(i + 1) * self.blocks.len() / points];
            let peak = range.iter().fold(0f32, |m, b| m.max(b.0));
            let (sum, n) = range
                .iter()
                .fold((0f64, 0usize), |(s, n), b| (s + b.1, n + b.2));
            peaks.push(to_byte(f64::from(peak)));
            rms.push(to_byte((sum / n.max(1) as f64).sqrt()));
        }
        let lufs = self.meter.loudness_global().ok().filter(|l| l.is_finite());
        let (bpm, key) = (self.features.tempo(), self.features.key());
        Ok(Analysis {
            duration_ms: self.frames * 1000 / u64::from(self.rate.max(1)),
            sample_rate: self.rate,
            channels: self.channels as u16,
            peaks,
            rms,
            lufs,
            bpm,
            key,
        })
    }
}

fn to_byte(amplitude: f64) -> u8 {
    (amplitude.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 16-bit PCM WAV with a sine wave of the given amplitude per channel.
    fn sine_wav(path: &Path, seconds: f64, rate: u32, channels: u16, amplitude: f64) {
        let frames = (seconds * f64::from(rate)) as u32;
        let data_len = frames * u32::from(channels) * 2;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            let t = f64::from(i) / f64::from(rate);
            let s = (amplitude * (2.0 * std::f64::consts::PI * 997.0 * t).sin() * 32767.0) as i16;
            for _ in 0..channels {
                out.extend_from_slice(&s.to_le_bytes());
            }
        }
        File::create(path).unwrap().write_all(&out).unwrap();
    }

    #[test]
    fn sine_wave_overview_and_loudness() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        sine_wav(&path, 3.0, 48_000, 2, 0.5);

        let a = analyze(&path).unwrap();
        assert_eq!(a.duration_ms, 3000);
        assert_eq!((a.sample_rate, a.channels), (48_000, 2));
        assert_eq!(a.peaks.len(), a.rms.len());
        assert!(a.peaks.len() > 100);
        // Peak 0.5 → 127; RMS of a sine is peak/√2 ≈ 0.354 → 90.
        assert!(
            a.peaks.iter().all(|&p| (125..=129).contains(&p)),
            "{:?}",
            &a.peaks[..8]
        );
        assert!(
            a.rms.iter().all(|&r| (88..=92).contains(&r)),
            "{:?}",
            &a.rms[..8]
        );
        // A full-scale 997 Hz stereo sine reads ≈ 0 LUFS; at 0.5 that is −6 dB.
        let lufs = a.lufs.unwrap();
        assert!((lufs - -6.0).abs() < 0.5, "{lufs}");
    }

    #[test]
    fn silence_has_no_loudness() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("silence.wav");
        sine_wav(&path, 1.0, 44_100, 1, 0.0);
        let a = analyze(&path).unwrap();
        assert_eq!(a.duration_ms, 1000);
        assert_eq!(a.lufs, None);
        assert!(a.peaks.iter().all(|&p| p == 0));
    }

    #[test]
    fn rejects_non_audio() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.wav");
        std::fs::write(&path, "definitely not audio").unwrap();
        assert!(analyze(&path).is_err());
    }
}
