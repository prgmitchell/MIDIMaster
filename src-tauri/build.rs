fn main() {
    generate_builtin_plugins();
    tauri_build::build()
}

fn generate_builtin_plugins() {
    use std::{env, fs, path::PathBuf};
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("builtin_plugins");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut directories: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("manifest.json").is_file())
        .collect();
    directories.sort();
    let mut generated = String::from("const BUNDLED_PLUGINS: &[BundledPlugin] = &[\n");
    for directory in directories {
        let manifest_path = directory.join("manifest.json");
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let id = manifest["id"].as_str().expect("plugin ID");
        assert_eq!(directory.file_name().unwrap().to_str().unwrap(), id);
        assert_eq!(manifest["api_version"], "1");
        let entry = manifest["entry"].as_str().expect("plugin entry");
        assert_eq!(entry, "plugin.mjs");
        let icon = manifest["icon"].as_str().expect("bundled plugin icon");
        assert_eq!(std::path::Path::new(icon).components().count(), 1);
        let entry_path = directory.join(entry);
        let icon_path = directory.join(icon);
        assert!(entry_path.is_file() && icon_path.is_file());
        generated.push_str(&format!(
            "BundledPlugin {{ id: {id:?}, manifest: include_str!({manifest_path:?}), code: include_str!({entry_path:?}), assets: &[({icon:?}, include_bytes!({icon_path:?}) as &[u8])] }},\n"
        ));
    }
    generated.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("builtin_plugins.rs"),
        generated,
    )
    .unwrap();
}
