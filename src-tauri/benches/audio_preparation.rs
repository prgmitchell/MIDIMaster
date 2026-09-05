#[path = "../../scripts/perf/native_support.rs"]
mod support;

use midimaster::model::SoundboardMapping;
use midimaster::perf_bench::prepare_soundboard_source;
use std::fs::File;
use std::io::Write;
use std::path::Path;

fn write_synthetic_wav(path: &Path) {
    let data_length = 310_u32 * 48_000 * 2 * 2;
    let mut file = File::create(path).expect("create synthetic WAV");
    file.write_all(b"RIFF").unwrap();
    file.write_all(&(data_length + 36).to_le_bytes()).unwrap();
    file.write_all(b"WAVEfmt ").unwrap();
    file.write_all(&16_u32.to_le_bytes()).unwrap();
    file.write_all(&1_u16.to_le_bytes()).unwrap();
    file.write_all(&2_u16.to_le_bytes()).unwrap();
    file.write_all(&48_000_u32.to_le_bytes()).unwrap();
    file.write_all(&192_000_u32.to_le_bytes()).unwrap();
    file.write_all(&4_u16.to_le_bytes()).unwrap();
    file.write_all(&16_u16.to_le_bytes()).unwrap();
    file.write_all(b"data").unwrap();
    file.write_all(&data_length.to_le_bytes()).unwrap();
    file.set_len(u64::from(data_length) + 44).unwrap();
}

fn main() {
    let path = std::env::temp_dir().join(format!(
        "midimaster-audio-bench-{}.wav",
        uuid::Uuid::new_v4()
    ));
    write_synthetic_wav(&path);
    for start_ms in [0, 30_000, 300_000] {
        let mapping = SoundboardMapping {
            path: path.to_string_lossy().into_owned(),
            display: "Synthetic silence".into(),
            trim_start_ms: start_ms,
            trim_end_ms: Some(start_ms + 1000),
            volume: 1.0,
            speed: 1.0,
            output_device_id: None,
            output_device_display: None,
            send_to_monitor: true,
            send_to_virtual_mic: false,
        };
        let mut result = support::measure("soundboard.prepare_actual_source", 15, 0, || {
            let first =
                prepare_soundboard_source(std::hint::black_box(&mapping)).expect("prepare WAV");
            assert_eq!(first, Some(0.0));
        });
        result["trim_start_ms"] = serde_json::json!(start_ms);
        result["file_bytes"] = serde_json::json!(59_520_044_u64);
        result["format"] =
            serde_json::json!("WAV PCM16 stereo48kHz, generated silence, warm OS file cache");
        result["scope"] = serde_json::json!(
            "actual path validation/open/decoder/trim/first sample/drop; no device or playback"
        );
        println!("{result}");
    }
    std::fs::remove_file(path).expect("remove generated WAV");
}
