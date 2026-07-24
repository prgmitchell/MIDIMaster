import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appSource, updaterSource, shutdownSource] = await Promise.all([
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/commands/updates.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/shutdown.rs", import.meta.url), "utf8"),
]);

const combinedExitSources = `${appSource}\n${updaterSource}`;

assert.doesNotMatch(
  combinedExitSources,
  /\bapp(?:_handle)?\.restart\s*\(/u,
  "graceful restart paths must not bypass coordinated cleanup",
);

for (const source of [
  "tray_restart",
  "tray_quit",
  "window_close",
  "window_destroyed",
  "updater_restart",
]) {
  assert.match(
    combinedExitSources,
    new RegExp(`ShutdownAction::(?:Exit\\(0\\)|Restart)[\\s\\S]{0,100}"${source}"`, "u"),
    `${source} must route through the shutdown coordinator`,
  );
}

assert.match(appSource, /\.build\(tauri::generate_context!\(\)\)/u);
assert.match(appSource, /tauri::RunEvent::ExitRequested/u);
assert.match(appSource, /shutdown::handle_exit_requested/u);
assert.match(appSource, /tauri::RunEvent::Exit/u);
assert.match(appSource, /shutdown::finish_unexpected_exit/u);

assert.match(updaterSource, /\.on_before_exit\(/u);
assert.match(updaterSource, /shutdown::prepare_for_updater_exit/u);
assert.match(updaterSource, /updater_exit_app\.cleanup_before_exit\(\)/u);
assert.match(shutdownSource, /const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs\(2\)/u);
assert.match(shutdownSource, /const BACKGROUND_TASK_TIMEOUT: Duration = Duration::from_millis\(500\)/u);
assert.match(shutdownSource, /midi\.stop\(\)/u);
assert.match(shutdownSource, /\.shutdown_all\(WEBSOCKET_CLOSE_TIMEOUT\)/u);
assert.match(shutdownSource, /\.disconnect_for_shutdown\(\)/u);
assert.match(shutdownSource, /source=updater_install action=UpdaterInstall/u);
assert.match(shutdownSource, /ShutdownAction::Restart => app\.request_restart\(\)/u);
assert.ok(
  shutdownSource.indexOf("mark_complete();") < shutdownSource.indexOf("app.request_restart()"),
  "cleanup must be marked complete before Tauri receives a restart request",
);

console.log("Graceful shutdown lifecycle regression test passed");
