//! Prints the analysis of an audio file: `cargo run --example analyze -- song.wav`

use std::time::Instant;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: analyze <audio file>");
    let started = Instant::now();
    match takes_audio::analyze(path.as_ref()) {
        Ok(a) => println!(
            "{:.1}s, {} Hz, {} ch, {} points, loudness {} — analyzed in {:.2?}",
            a.duration_ms as f64 / 1000.0,
            a.sample_rate,
            a.channels,
            a.peaks.len(),
            a.lufs.map_or("silence".into(), |l| format!("{l:.1} LUFS")),
            started.elapsed()
        ),
        Err(e) => eprintln!("error: {e}"),
    }
}
