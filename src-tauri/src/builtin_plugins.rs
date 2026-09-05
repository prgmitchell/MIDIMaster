use crate::plugin_api::ensure_builtin_plugin;
use tauri::AppHandle;

struct BundledPlugin {
    id: &'static str,
    manifest: &'static str,
    code: &'static str,
    assets: &'static [(&'static str, &'static [u8])],
}

// Generated from manifests by Cargo. The JavaScript bundles are checked in, so
// ordinary Cargo builds do not require Node or the plugin authoring toolchain.
include!(concat!(env!("OUT_DIR"), "/builtin_plugins.rs"));

pub(crate) fn ensure_builtin_plugins(app: &AppHandle) {
    for plugin in BUNDLED_PLUGINS {
        ensure_builtin_plugin(app, plugin.id, plugin.manifest, plugin.code, plugin.assets);
    }
}
