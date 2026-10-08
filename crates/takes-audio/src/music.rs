//! Rough musical features: tempo (BPM) and key. Both are estimates, good
//! for labelling demos ("≈ 128 BPM, Am"), not for beat-matching.

use rustfft::FftPlanner;
use rustfft::num_complex::Complex;

/// Analysis runs on mono audio at about this rate: enough for rhythm and
/// for pitches up to ~2 kHz, and cheap.
const TARGET_RATE: u32 = 11_025;
/// Only the first minutes are analysed; that settles tempo and key.
const MAX_SECONDS: usize = 600;

/// Collects a downsampled mono signal while the file is decoded.
pub struct Features {
    factor: usize,
    rate: f32,
    acc: f32,
    acc_len: usize,
    signal: Vec<f32>,
    limit: usize,
}

impl Features {
    pub fn new(rate: u32) -> Self {
        let factor = (rate as f32 / TARGET_RATE as f32).round().max(1.0) as usize;
        let rate = rate as f32 / factor as f32;
        Self {
            factor,
            rate,
            acc: 0.0,
            acc_len: 0,
            signal: Vec::new(),
            limit: MAX_SECONDS * rate as usize,
        }
    }

    /// One mono sample at the source rate.
    pub fn push(&mut self, sample: f32) {
        if self.signal.len() >= self.limit {
            return;
        }
        // Averaging is a crude low-pass, plenty for onsets and chroma.
        self.acc += sample;
        self.acc_len += 1;
        if self.acc_len == self.factor {
            self.signal.push(self.acc / self.factor as f32);
            self.acc = 0.0;
            self.acc_len = 0;
        }
    }

    pub fn tempo(&self) -> Option<f64> {
        estimate_tempo(&self.signal, self.rate)
    }

    pub fn key(&self) -> Option<String> {
        estimate_key(&self.signal, self.rate)
    }
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos())
        .collect()
}

/// Magnitude spectra of overlapping windows of `signal`.
fn spectra(signal: &[f32], size: usize, hop: usize, mut each: impl FnMut(&[Complex<f32>])) {
    if signal.len() < size {
        return;
    }
    let fft = FftPlanner::new().plan_fft_forward(size);
    let window = hann(size);
    let mut buf = vec![Complex::default(); size];
    let mut scratch = vec![Complex::default(); fft.get_inplace_scratch_len()];
    for start in (0..=signal.len() - size).step_by(hop) {
        for ((b, s), w) in buf
            .iter_mut()
            .zip(&signal[start..start + size])
            .zip(&window)
        {
            *b = Complex::new(s * w, 0.0);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        each(&buf[..size / 2]);
    }
}

/// Tempo from the periodicity of note onsets (spectral flux).
fn estimate_tempo(signal: &[f32], rate: f32) -> Option<f64> {
    // A fine hop: at 120 BPM a beat is ~86 frames, so the peak of the
    // autocorrelation does not smear over neighbouring lags.
    const SIZE: usize = 512;
    const HOP: usize = 64;
    let mut previous = vec![0f32; SIZE / 2];
    let mut flux = Vec::new();
    spectra(signal, SIZE, HOP, |bins| {
        let mut rise = 0.0;
        for (bin, prev) in bins.iter().zip(previous.iter_mut()).skip(1) {
            let level = (1.0 + 1000.0 * bin.norm()).ln();
            rise += (level - *prev).max(0.0);
            *prev = level;
        }
        flux.push(rise);
    });
    let fps = f64::from(rate) / HOP as f64;
    if flux.len() < (fps * 6.0) as usize {
        return None;
    }
    // Onset strength above its local average (half a second around),
    // smoothed over ~20 ms so slightly loose playing still lines up.
    let half = (fps / 4.0) as usize;
    let mut prefix = vec![0f64; flux.len() + 1];
    for (i, f) in flux.iter().enumerate() {
        prefix[i + 1] = prefix[i] + f64::from(*f);
    }
    let raw: Vec<f64> = (0..flux.len())
        .map(|i| {
            let (from, to) = (i.saturating_sub(half), (i + half + 1).min(flux.len()));
            let mean = (prefix[to] - prefix[from]) / (to - from) as f64;
            (f64::from(flux[i]) - mean).max(0.0)
        })
        .collect();
    let smooth = (fps / 100.0).round().max(1.0) as usize;
    let onsets: Vec<f64> = (0..raw.len())
        .map(|i| {
            let window = &raw[i.saturating_sub(smooth)..(i + smooth + 1).min(raw.len())];
            window.iter().sum::<f64>() / window.len() as f64
        })
        .collect();
    let energy: f64 = onsets.iter().map(|o| o * o).sum::<f64>() / onsets.len() as f64;
    if energy <= f64::EPSILON {
        return None;
    }
    const MULTIPLES: usize = 4;
    let lag_bpm = |lag: f64| 60.0 * fps / lag;
    let min_lag = (60.0 * fps / 200.0).floor() as usize;
    let max_lag = (60.0 * fps / 50.0).ceil() as usize;
    let corr: Vec<f64> = (0..=MULTIPLES * (max_lag + 1))
        .map(|lag| {
            if lag >= onsets.len() {
                return 0.0;
            }
            let n = onsets.len() - lag;
            onsets[..n]
                .iter()
                .zip(&onsets[lag..])
                .map(|(a, b)| a * b)
                .sum::<f64>()
                / n as f64
                / energy
        })
        .collect();
    let at = |lag: f64| {
        let i = lag.floor() as usize;
        let frac = lag - i as f64;
        corr[i] * (1.0 - frac) + corr[(i + 1).min(corr.len() - 1)] * frac
    };
    // A real beat repeats at every multiple of its period; a syncopated
    // figure (a kick every three eighths) does not.
    let comb =
        |lag: f64| (1..=MULTIPLES).map(|k| at(lag * k as f64)).sum::<f64>() / MULTIPLES as f64;
    // Prefer tempi near 120 BPM (log-normal, an octave wide): halving and
    // doubling are the classic mistakes.
    let score = |lag: f64| {
        let octaves = (lag_bpm(lag) / 120.0).log2();
        comb(lag) * (-0.5 * octaves * octaves).exp()
    };
    let best = (min_lag..=max_lag).max_by(|&a, &b| score(a as f64).total_cmp(&score(b as f64)))?;
    // No pulse that stands out from the rest (a pad, a held note, speech):
    // no tempo. Music scores 1.6–2.7 here, steady tones about 1.2.
    let mean =
        (min_lag..=max_lag).map(|l| comb(l as f64)).sum::<f64>() / (max_lag - min_lag + 1) as f64;
    if comb(best as f64) < 1.35 * mean {
        return None;
    }
    // Sub-frame precision: the best fractional lag near the best frame.
    let lag = (-10..=10)
        .map(|step| best as f64 + f64::from(step) / 20.0)
        .max_by(|a, b| comb(*a).total_cmp(&comb(*b)))?;
    let bpm = lag_bpm(lag);
    Some((bpm * 10.0).round() / 10.0)
}

/// Krumhansl–Kessler key profiles, starting at the tonic.
const MAJOR: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
const MAJOR_NAMES: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];
const MINOR_NAMES: [&str; 12] = [
    "Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm",
];

/// Key from how much each pitch class sounds, matched against the
/// major and minor profiles in all 12 transpositions.
fn estimate_key(signal: &[f32], rate: f32) -> Option<String> {
    const SIZE: usize = 8192;
    let hz_per_bin = rate / SIZE as f32;
    // Pitch class of every bin from A1 to A6, C = 0.
    let classes: Vec<Option<usize>> = (0..SIZE / 2)
        .map(|k| {
            let hz = k as f32 * hz_per_bin;
            (55.0..=1760.0).contains(&hz).then(|| {
                let semitone = (12.0 * (hz / 440.0).log2()).round() as i32 + 9;
                semitone.rem_euclid(12) as usize
            })
        })
        .collect();
    let mut chroma = [0f64; 12];
    spectra(signal, SIZE, SIZE / 2, |bins| {
        let mut frame = [0f64; 12];
        for (bin, class) in bins.iter().zip(&classes) {
            if let Some(c) = class {
                frame[*c] += f64::from(bin.norm());
            }
        }
        // Every window counts the same, loud or quiet.
        let total: f64 = frame.iter().sum();
        if total > 1e-3 {
            for (c, f) in chroma.iter_mut().zip(frame) {
                *c += f / total;
            }
        }
    });
    if chroma.iter().sum::<f64>() <= f64::EPSILON {
        return None;
    }
    let mut best: Option<(f64, &str)> = None;
    for tonic in 0..12 {
        for (profile, names) in [(&MAJOR, &MAJOR_NAMES), (&MINOR, &MINOR_NAMES)] {
            let rotated: Vec<f64> = (0..12).map(|i| chroma[(tonic + i) % 12]).collect();
            let r = pearson(&rotated, profile);
            if best.is_none_or(|(b, _)| r > b) {
                best = Some((r, names[tonic]));
            }
        }
    }
    // A flat or noisy spectrum matches no key well.
    best.filter(|(r, _)| *r >= 0.5)
        .map(|(_, name)| name.to_owned())
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        cov += (x - ma) * (y - mb);
        va += (x - ma) * (x - ma);
        vb += (y - mb) * (y - mb);
    }
    if va <= 0.0 || vb <= 0.0 {
        0.0
    } else {
        cov / (va * vb).sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;

    fn features(signal: impl Iterator<Item = f32>) -> Features {
        let mut f = Features::new(RATE);
        signal.for_each(|s| f.push(s));
        f
    }

    /// A kick-like thump on every beat.
    fn click_track(bpm: f64, seconds: f64) -> impl Iterator<Item = f32> {
        let beat = 60.0 / bpm;
        (0..(seconds * f64::from(RATE)) as usize).map(move |i| {
            let t = i as f64 / f64::from(RATE);
            let since = t % beat;
            let thump = (2.0 * std::f64::consts::PI * 70.0 * since).sin() * (-since * 30.0).exp();
            let tick = if since < 0.003 { 0.5 } else { 0.0 };
            (0.8 * thump + tick) as f32
        })
    }

    /// Chords (as MIDI note lists) of two seconds each, with overtones.
    fn chords(progression: &[&[u8]], repeats: usize) -> impl Iterator<Item = f32> {
        let notes: Vec<Vec<f64>> = progression
            .iter()
            .map(|c| {
                c.iter()
                    .map(|&m| 440.0 * 2f64.powf((f64::from(m) - 69.0) / 12.0))
                    .collect()
            })
            .collect();
        let per_chord = 2 * RATE as usize;
        (0..per_chord * notes.len() * repeats).map(move |i| {
            let t = i as f64 / f64::from(RATE);
            let chord = &notes[(i / per_chord) % notes.len()];
            let mut s = 0.0;
            for hz in chord {
                for h in 1..=3 {
                    s += (2.0 * std::f64::consts::PI * hz * h as f64 * t).sin() / (h * h) as f64;
                }
            }
            (s * 0.15) as f32
        })
    }

    #[test]
    fn tempo_of_a_click_track() {
        for bpm in [128.0, 90.0, 100.0] {
            let found = features(click_track(bpm, 20.0)).tempo().unwrap();
            assert!((found - bpm).abs() < 1.5, "{bpm} → {found}");
        }
        // Bare clicks at drum & bass speed read as well in half time.
        let found = features(click_track(174.0, 20.0)).tempo().unwrap();
        assert!(
            (found - 174.0).abs() < 1.5 || (found - 87.0).abs() < 1.0,
            "{found}"
        );
    }

    /// A two-beat groove at 120 BPM: kick on 1 and on the "and" of 2
    /// (three eighths apart), snare on 2, hats on every eighth.
    #[test]
    fn tempo_of_a_syncopated_groove() {
        let eighth = 0.25;
        let hit = |t: f64, at: &[f64], len: f64| at.iter().any(|&a| (t - a).rem_euclid(1.0) < len);
        let groove = (0..20 * RATE as usize).map(move |i| {
            let t = i as f64 / f64::from(RATE);
            let since = |starts: &[f64]| {
                starts
                    .iter()
                    .map(|s| (t - s).rem_euclid(1.0))
                    .fold(f64::MAX, f64::min)
            };
            let kick = since(&[0.0, 3.0 * eighth]);
            let snare = since(&[0.5]);
            let mut s = (2.0 * std::f64::consts::PI * 60.0 * kick).sin() * (-kick * 25.0).exp();
            s += 0.6 * (2.0 * std::f64::consts::PI * 190.0 * snare).sin() * (-snare * 40.0).exp();
            if hit(t, &[0.0, 0.25, 0.5, 0.75], 0.004) {
                s += 0.2 * ((i * 7919 % 101) as f64 / 50.0 - 1.0);
            }
            (0.5 * s) as f32
        });
        let found = features(groove).tempo().unwrap();
        assert!((found - 120.0).abs() < 1.5, "{found}");
    }

    #[test]
    fn no_tempo_in_a_steady_tone() {
        let tone = (0..10 * RATE as usize)
            .map(|i| (2.0 * std::f32::consts::PI * 220.0 * i as f32 / RATE as f32).sin());
        assert_eq!(features(tone).tempo(), None);
    }

    #[test]
    fn key_of_chord_progressions() {
        // Am – Dm – E – Am
        let a_minor: &[&[u8]] = &[&[57, 60, 64], &[62, 65, 69], &[64, 68, 71], &[57, 60, 64]];
        assert_eq!(features(chords(a_minor, 2)).key().as_deref(), Some("Am"));
        // C – F – G – C
        let c_major: &[&[u8]] = &[&[60, 64, 67], &[65, 69, 72], &[67, 71, 74], &[60, 64, 67]];
        assert_eq!(features(chords(c_major, 2)).key().as_deref(), Some("C"));
        // Eb – Ab – Bb – Eb
        let e_flat: &[&[u8]] = &[&[63, 67, 70], &[68, 72, 75], &[70, 74, 77], &[63, 67, 70]];
        assert_eq!(features(chords(e_flat, 2)).key().as_deref(), Some("Eb"));
    }

    #[test]
    fn silence_has_neither() {
        let f = features(std::iter::repeat_n(0.0, 10 * RATE as usize));
        assert_eq!((f.tempo(), f.key()), (None, None));
    }
}
