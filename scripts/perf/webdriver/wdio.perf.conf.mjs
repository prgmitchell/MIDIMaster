import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const appBinary = resolve(process.env.MIDIMASTER_PERF_APPLICATION
  || join(repoRoot, "src-tauri", "target", "release", "midimaster.exe"));

function requireIsolatedEnvironment() {
  const required = [
    "MIDIMASTER_PERF_APP_DATA_DIR",
    "MIDIMASTER_PERF_WEBVIEW_DATA_DIR",
    "MIDIMASTER_PERF_RESULTS_DIR",
    "MIDIMASTER_PERF_RUN_ID",
    "MIDIMASTER_PERF_SCENARIO_ID",
  ];
  const missing = required.filter((name) => !String(process.env[name] || "").trim());
  if (missing.length) {
    throw new Error(`Refusing WebdriverIO audit without isolated run variables: ${missing.join(", ")}. Use Invoke-WdioJourney.ps1.`);
  }
  for (const name of required.slice(0, 3)) {
    if (!isAbsolute(process.env[name])) throw new Error(`${name} must be absolute`);
  }
}

function verifyAuditBinary() {
  if (!existsSync(appBinary)) throw new Error(`Audit application not found: ${appBinary}`);
  if (process.env.MIDIMASTER_PERF_ALLOW_UNVERIFIED === "1") return;
  const markerPath = join(dirname(appBinary), `${basename(appBinary, ".exe")}.perf-audit.json`);
  if (!existsSync(markerPath)) throw new Error(`Missing perf-audit safety marker: ${markerPath}`);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const actualHash = createHash("sha256").update(readFileSync(appBinary)).digest("hex");
  if (marker.feature !== "perf-audit" || marker.executable_sha256 !== actualHash) {
    throw new Error("The perf-audit safety marker does not match the application binary");
  }
}

requireIsolatedEnvironment();
verifyAuditBinary();

export const config = {
  runner: "local",
  specs: [join(import.meta.dirname, "performance.e2e.mjs")],
  maxInstances: 1,
  capabilities: [{
    browserName: "tauri",
    "tauri:options": { application: appBinary },
  }],
  services: [["@wdio/tauri-service", {
    appBinaryPath: appBinary,
    driverProvider: "official",
    autoInstallTauriDriver: process.env.MIDIMASTER_PERF_AUTO_INSTALL_DRIVER === "1",
    autoDownloadEdgeDriver: true,
    captureBackendLogs: false,
    captureFrontendLogs: false,
    startTimeout: 60_000,
    commandTimeout: 60_000,
    logLevel: "warn",
  }]],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  mochaOpts: { ui: "bdd", timeout: 120_000 },
};
