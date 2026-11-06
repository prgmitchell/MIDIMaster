use std::{
    io::Read,
    path::{Path, PathBuf},
};

// The chooser is an external input boundary. E2E builds consume a one-shot
// selection inside the isolated fixture; parsing, validation and IO stay real.
#[cfg(feature = "e2e")]
pub(crate) fn fixture_selection() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("MIDIMASTER_PERF_APP_DATA_DIR")?);
    if !root.is_absolute() {
        return None;
    }
    let selection = root.join("e2e-dialog.json");
    let bytes = std::fs::read(&selection).ok()?;
    std::fs::remove_file(selection).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(crate) fn pick(dialog: rfd::FileDialog) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    {
        let _ = dialog;
        fixture_selection()
    }
    #[cfg(not(feature = "e2e"))]
    {
        dialog.pick_file()
    }
}

pub(crate) fn save(dialog: rfd::FileDialog) -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    {
        let _ = dialog;
        fixture_selection()
    }
    #[cfg(not(feature = "e2e"))]
    {
        dialog.save_file()
    }
}

pub(crate) fn read_text(path: &Path, max_bytes: u64) -> Result<String, String> {
    let mut text = String::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(max_bytes + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > max_bytes {
        return Err("Selected file is too large".to_string());
    }
    Ok(text)
}
