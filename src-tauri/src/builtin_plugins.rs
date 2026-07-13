use crate::plugin_api::ensure_builtin_plugin;
use tauri::AppHandle;

pub(crate) fn ensure_builtin_plugins(app: &AppHandle) {
    ensure_builtin_plugin(
        app,
        "hue",
        include_str!("../builtin_plugins/hue/manifest.json"),
        include_str!("../builtin_plugins/hue/plugin.mjs"),
        &[(
            "HueLogo.svg",
            include_bytes!("../builtin_plugins/hue/HueLogo.svg") as &[u8],
        )],
    );
    ensure_builtin_plugin(
        app,
        "wavelink",
        include_str!("../builtin_plugins/wavelink/manifest.json"),
        include_str!("../builtin_plugins/wavelink/plugin.mjs"),
        &[(
            "WaveLinkLogo.png",
            include_bytes!("../builtin_plugins/wavelink/WaveLinkLogo.png") as &[u8],
        )],
    );
    ensure_builtin_plugin(
        app,
        "obs",
        include_str!("../builtin_plugins/obs/manifest.json"),
        include_str!("../builtin_plugins/obs/plugin.mjs"),
        &[(
            "OBSLogo.png",
            include_bytes!("../builtin_plugins/obs/OBSLogo.png") as &[u8],
        )],
    );
    ensure_builtin_plugin(
        app,
        "voicemeeter",
        include_str!("../builtin_plugins/voicemeeter/manifest.json"),
        include_str!("../builtin_plugins/voicemeeter/plugin.mjs"),
        &[(
            "VoicemeeterLogo.png",
            include_bytes!("../builtin_plugins/voicemeeter/VoicemeeterLogo.png") as &[u8],
        )],
    );
}
