# MIDIMaster

https://midimaster.app/

DISCLAIMER: nearly 100% of everything you see on this repo was written with the assistance of AI.

MIDIMaster is a desktop app that lets you bind MIDI controls (faders/knobs/buttons) to:

- System audio (master, focused app, per-app sessions)
- Audio devices (playback/recording)
- Integrations provided by runtime plugins (for example: OBS Studio, Elgato Wave Link, Philips Hue)

Integrations are plugin-driven. Plugins can be installed at runtime (no rebuild required) and can ship their own:

- Target lists for the binding picker (including nested menus)
- Connection UI inside the Connections modal
- Runtime behavior when a binding triggers
- Feedback updates (UI + OSD + motor faders)

<img width="1308" height="890" alt="midimaster-night-light" src="https://github.com/user-attachments/assets/80d65d1d-9210-4777-9528-f5b37cf27911" />

## Platform support

- Windows only (system audio + device control)

## Plugins and the Store

Plugins are distributed as `.midimaster` packages.

- Install from file: `Plugins -> Installed -> Install Plugin...`
- Install from the in-app Store: `Plugins -> Store`

The in-app Store lists plugins from the official MIDIMaster catalog and installs them into your
config directory.

- The app verifies Store downloads using a trusted public key.
- The Store service/catalog and signing keys are maintained separately (not in this repository).
- The official catalog is curated (plugins may be accepted/rejected/removed at the maintainer's discretion).

## Trademarks and attribution

Third-party product names, trademarks, and logos are property of their respective owners and are
used for identification purposes only.

This project is not affiliated with, endorsed by, or sponsored by OBS Project, Elgato, Signify, Discord,
or any other third-party vendor.

Some third-party logos are included in this repository and shown in the UI (for example in the
bundled integration plugins) purely to help users recognize the integration they are configuring.
If you are a trademark owner and would like a logo removed or adjusted to comply with brand
guidelines, please open an issue.

## Development

This repo is a Tauri v2 app. The frontend is plain static HTML/CSS/JS (no Node build step).

Prereqs (Windows)

- Rust (stable) and Cargo
- Visual Studio Build Tools / MSVC toolchain (required by Rust on Windows)
- Tauri CLI v2 (`cargo install tauri-cli --version "^2" --locked`)

```bash
cargo tauri dev
```

Build a release bundle locally

```bash
cargo tauri build
```

Store URL override (forks)

The in-app Store catalog URL can be overridden with `MIDIMASTER_STORE_URL`.

Example (PowerShell):

```powershell
$env:MIDIMASTER_STORE_URL = "https://example.com/catalog.json"
cargo tauri dev
```

## Releases

Releases are created from git tags.

One-time updater key setup (required for built-in updates):

1. Generate a signing keypair locally:
   ```powershell
   cargo tauri signer generate -w "$HOME/.tauri/midimaster.key"
   ```
2. Copy the generated public key into `src-tauri/tauri.conf.json` at `plugins.updater.pubkey`.
3. Add these GitHub repo secrets for the release workflow:
   - `TAURI_SIGNING_PRIVATE_KEY` (contents of the private key file, or a secure path)
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty string if no password)
   - `NETLIFY_AUTH_TOKEN` (token with access to your Netlify site)
   - `NETLIFY_SITE_ID` (Netlify project/site ID)

Release flow:

1. Update `src-tauri/Cargo.toml` version.
2. Create and push a tag in the form `v<version>` (example: `v0.1.0`).

Pushing the tag triggers the GitHub Actions release workflow, which builds the Windows bundle and
publishes installer assets to GitHub Releases and updater metadata to Netlify.

Built-in updater behavior:

- Update checks use Netlify metadata (`https://midimaster.netlify.app/updates/latest.json`).
- Metadata points to installer binaries hosted on GitHub Releases.
- Stable releases only are offered.
- If in-app update fails, users can still install manually from the GitHub release page.

Important Netlify publishing note:

- The public store catalog (`/catalog.json`) and updater metadata (`/updates/latest.json`) share the same Netlify site.
- Store publishes must preserve `/updates/latest.json`; a blind full-site deploy from the store directory can remove updater metadata and break in-app updates.
- Use `scripts/local-store/deploy_store_netlify.ps1` for store publishes so the deploy merges store files while preserving the updater path.

Bridge migration (one release):

- Existing app installs that still check GitHub need one bridge release.
- For the bridge release, upload `latest.json` to GitHub release assets as well.
- After the bridge release, GitHub assets should be `.exe` files only.
- Workflow toggles:
  - `UPDATER_BRIDGE_RELEASE` (repo variable): defaults to `true` when unset.
    Set to `false` after the bridge release to stop uploading `latest.json` to GitHub.
  - `UPDATER_BRIDGE_INCLUDE_SIG` (repo variable): optional; set to `true` only if you also want `.sig` files uploaded during bridge mode.

Documentation

- User guide: `docs/USER_GUIDE.md`
- Plugin developer guide (API v1): `docs/PLUGIN_DEVELOPER_GUIDE.md`
- Architecture guardrails: `docs/ARCHITECTURE_GUARDRAILS.md`

Plugin examples

- Demo plugin: `plugin-example/demo/`
- Starter template: `plugin-example/template/`

## License

MIT. See `LICENSE`.
