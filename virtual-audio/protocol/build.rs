use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../src-tauri/windows/virtual-audio/vendor/usbip-win2-0.9.7.7.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let payload: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest).expect("read approved USB/IP manifest"))
            .expect("valid USB/IP manifest");
    let mut source = String::new();
    for (name, key) in [
        ("USBIP_VERSION", "version"),
        ("USBIP_FILE", "file"),
        ("USBIP_SHA256", "sha256"),
    ] {
        let value = payload[key].as_str().expect("string manifest field");
        source.push_str(&format!("pub const {name}: &str = {value:?};\n"));
    }
    let size = payload["size"].as_u64().expect("numeric payload size");
    source.push_str(&format!("pub const USBIP_SIZE: u64 = {size};\n"));
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("payload.rs");
    fs::write(output, source).expect("write payload constants");
}
