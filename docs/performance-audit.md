# MIDIMaster performance audit lab

This lab benchmarks MIDIMaster without installed-user telemetry. Fixtures are synthetic, every application run defaults to disposable app data under the Windows temporary directory, and raw ETW, CDP, heap, and run artifacts are gitignored. Treat those raw files as private: they can contain local device, process, and filesystem metadata.

## Deterministic checks

Use Node 20 or newer. In Windows PowerShell, `npm.cmd` avoids machines whose execution policy blocks `npm.ps1`.

```powershell
npm.cmd ci
npm.cmd run perf:test
npm.cmd run perf:guard
```

The guard verifies that main, OSD, and update windows use distinct module entries and that the main window's eagerly selected image payload stays within `scripts/perf/config/asset-budgets.json`. CI runs only these stable checks and fixture generation; hosted-runner wall-clock timings are not release gates.

## Build the audit executable

The audit feature and query-string instrumentation are compiled into a local release-equivalent build by a config overlay. Normal release commands do not enable them.

```powershell
scripts/perf/windows/Build-PerfAudit.ps1
```

This builds `src-tauri/target/release/midimaster.exe` with release optimization, PDB symbols, the `perf-audit` feature, and `index.html?perf-audit=1&perf-scenario=installed-release`. It writes a hash-bound `.perf-audit.json` safety marker beside the executable. The launcher refuses executables without that marker because a normal production build may ignore the audit-only data-root override; use `-AllowUnverifiedExecutable` only in a disposable Windows user account or VM when measuring an installed baseline. Use `-Bundle` only when an installed NSIS/MSI journey is specifically required. Native microbenchmarks use:

```powershell
Push-Location src-tauri
cargo bench --features perf-audit --bench performance
Pop-Location
```

For the required code-generation A/B, build and archive each executable before building the next variant, then run the same fixture matrix with distinct variant labels:

```powershell
scripts/perf/windows/Build-PerfAudit.ps1 -OptimizationLevel z
# Copy the exe, PDB, and matching safety marker to a private z-variant directory.
scripts/perf/windows/Build-PerfAudit.ps1 -OptimizationLevel 3
# Adopt 3 only when the report meets the runtime and package-size thresholds.
```

## Generate disposable fixtures

The default generator writes outside the repository to `%TEMP%\MIDIMaster-perf-fixtures`. Each fixture contains `fixture.json`, `app-data/MIDIMaster`, and an empty WebView2 directory. It covers 0/50/250/500 bindings, 1/10 profiles, light/0.6 MB/5 MB aggregate profile shapes, and zero/one/all bundled-plugin modes.

```powershell
npm.cmd run perf:fixtures -- --clean
```

The 0.6 MB and 5 MB shapes store duplicated synthetic `icon_data` in integration targets. A zero-binding fixture intentionally remains small because it has no target in which an icon can exist.

## Run installed-app scenarios

One safe run needs only an executable. With no fixture argument, the launcher generates a 50-binding lightweight fixture. It copies the fixture before launch and redirects `APPDATA`, `LOCALAPPDATA`, `TEMP`, the audit app-data override, and WebView2 user data for that child process. It refuses to start while another process with the same executable name is running, preventing Tauri's single-instance handoff from reaching a normal installed instance.

```powershell
scripts/perf/windows/Invoke-PerfRun.ps1 `
  -ApplicationPath src-tauri/target/release/midimaster.exe `
  -ScenarioId startup-warm-b50-p1-light `
  -Variant current `
  -RunId current-warm-001
```

Pass `-FixturePath` to select a generated matrix entry. Passing `-ReusableWebViewDataDirectory` is the only way to write to a caller-selected WebView directory; use it only for disposable warm-cache data. In a `perf-audit` build, `-NetworkMode Offline` disables Store downloads, update traffic, plugin HTTP, Hue discovery/API calls, and plugin WebSocket opens without changing the machine firewall. The selected mode is included in the native audit snapshot.

For repeated launches:

```powershell
scripts/perf/windows/Invoke-PerfMatrix.ps1 `
  -ApplicationPath src-tauri/target/release/midimaster.exe `
  -FixturePattern "b*-p1-0.6mb-plugins-all" `
  -Iterations 15 `
  -CacheMode Clean `
  -Variant current

scripts/perf/windows/Invoke-PerfMatrix.ps1 `
  -ApplicationPath src-tauri/target/release/midimaster.exe `
  -FixturePattern "b*-p1-0.6mb-plugins-all" `
  -Iterations 30 `
  -CacheMode Warm `
  -Variant current
```

The full matrix and sample counts are versioned in `scripts/perf/config/matrix.json`. Five true cold-machine launches require a reboot or controlled VM snapshot between samples and remain a lab procedure, not an automated claim.

The WebdriverIO runner executes the versioned interaction contract in `scripts/perf/config/installed-journeys.json` against an isolated fixture. It verifies the hash-bound audit marker before starting, uses Tauri's official driver provider, lets the service download the matching Edge driver, and writes journey timings to `webdriver.ndjson`.

```powershell
# Install tauri-driver yourself once, or add -AutoInstallDriver to this first run.
scripts/perf/windows/Invoke-WdioJourney.ps1 `
  -ApplicationPath src-tauri/target/release/midimaster.exe `
  -FixturePath "$env:TEMP/MIDIMaster-perf-fixtures/b500-p10-light-plugins-all" `
  -Journey all `
  -ScenarioId interaction-webdriver-b500 `
  -Variant current `
  -AutoInstallDriver
```

Subsequent runs can omit `-AutoInstallDriver`. The runner performs only basic WebDriver element operations and the standard browser execute API, so it does not add a WebdriverIO plugin to normal application builds. Use one journey per fresh run when collecting statistically comparable interaction samples.

## Capture native and renderer traces

WPR/WPA capture requires the Windows Performance Toolkit and an elevated terminal:

```powershell
scripts/perf/windows/Invoke-WprAudit.ps1 `
  -ApplicationPath src-tauri/target/release/midimaster.exe `
  -ScenarioId startup-cold-b250-p1-0.6mb
```

For renderer tracing, run the application long enough for a second terminal to connect:

```powershell
# Terminal 1
scripts/perf/windows/Invoke-PerfRun.ps1 `
  -ApplicationPath src-tauri/target/release/midimaster.exe `
  -DurationSeconds 60 -CdpPort 9222

# Terminal 2 (Node 22+)
node scripts/perf/capture-cdp.mjs --endpoint http://127.0.0.1:9222 --duration-ms 10000 --variant current --native-run-id current-cdp-001 --scenario startup-cold-b250-p1-0.6mb
```

The collector records DevTools performance metrics, a DOM snapshot, a renderer trace, a heap snapshot, and `window.__MIDIMASTER_PERF__.snapshot()`. It also normalizes the snapshot to `frontend.ndjson` and writes the native/UI run-ID mapping to `correlation.json`; use the same explicit `-RunId` and `--native-run-id` when collecting concurrently. Use `--no-heap` or `--no-dom` for lower-overhead captures.

The launcher samples CPU, working set, handles, and process I/O across the root/WebView process tree. Its `system.network_io` observation is an all-adapter rate and can include unrelated traffic; use the WPR trace when process-attributed network evidence is required.

An audit build also writes low-volume startup and OSD milestones directly to the run's `frontend.ndjson`, so repeated launch matrices capture `startup.bindings_usable` without requiring a DevTools connection. High-rate MIDI-to-paint samples stay in the bounded in-page audit buffer and are collected by the CDP MIDI driver to avoid contaminating disk-I/O measurements.

### Deterministic MIDI bursts

Keep the audit app open with `-CdpPort 9222`, then run one matrix cell from another terminal:

```powershell
node scripts/perf/run-midi-cdp.mjs `
  --endpoint http://127.0.0.1:9222 `
  --rate 500 --controls 16 --kind continuous `
  --duration-seconds 10 `
  --scenario midi-continuous-500hz-16controls `
  --variant current
```

The driver calls `perf_audit_reset`, invokes `perf_audit_inject_midi` with Tauri keys `messageCount`, `ratePerSecond`, `controlCount`, and `messageKind`, waits for the queue to settle, then calls `perf_audit_snapshot`. Accepted kinds are `continuous`, `button`, and `action`; limits are 1–1,000,000 messages, 1–10,000 messages/second, and 1–16 controls. Results include native-action quantiles, queue depth, coalescing, and drops in `midi.ndjson`. The complete 125/500/1,000 Hz × 1/16-control contract is in `scripts/perf/config/midi-journeys.json`. Validate this synthetic path once with a virtual or physical MIDI loopback before treating it as representative of device input.

## Report and regression gates

Runtime producers append records conforming to `scripts/perf/config/result.schema.json`. One line is one metric observation, correlated by run, scenario, build variant, commit, and sanitized hardware summary.

```powershell
node scripts/perf/generate-report.mjs `
  --input perf-results/runs `
  --output perf-results/report `
  --baseline installed

node scripts/perf/evaluate-thresholds.mjs `
  --candidate perf-results/report/summary.json `
  --candidate-variant current `
  --baseline perf-results/installed/summary.json `
  --baseline-variant installed `
  --output perf-results/report/gates.json
```

The report emits `summary.json`, trend-ready `metrics.csv`, and `comparison.md`. Absolute acceptance targets and the dual relative-plus-absolute regression rules live in `scripts/perf/config/budgets.json`. Add `--require-all` only after the complete scenario matrix has been captured; otherwise absent scenarios are reported as missing rather than failing a partial experiment.

For each optimization wave, preserve the summarized JSON/CSV/Markdown in a private CI artifact or local audit record, rank bottlenecks by trace evidence, and note reverted or rejected experiments. Do not upload ETL or heap snapshots to public CI.

Keep dated audit records and experiment tables under the gitignored `perf-results/`
directory or in private CI artifacts. Only promote stable, reproducible conclusions into
this document or other public project documentation.
