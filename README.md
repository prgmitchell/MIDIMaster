# MIDIMaster

MIDIMaster is a desktop app that lets you bind MIDI controls (faders/knobs/buttons) to:

- System audio (master, focused app, per-app sessions)
- Audio devices (playback/recording)
- Integrations provided by runtime plugins (for example: OBS Studio, Elgato Wave Link)

Integrations are plugin-driven. Plugins can be installed at runtime (no rebuild required) and can ship their own:

- Target lists for the binding picker (including nested menus)
- Connection UI inside the Connections modal
- Runtime behavior when a binding triggers
- Feedback updates (UI + OSD + motor faders)

<img width="1118" height="1003" alt="image" src="https://github.com/user-attachments/assets/c524ff57-00a1-41bb-92ca-a85c367ea77f" />


## Platform support

- Windows: supported (system audio + device control)
- macOS/Linux: the app can build, but the audio backend is currently not implemented

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

This project is not affiliated with, endorsed by, or sponsored by OBS Project, Elgato, Discord,
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

1. Update `src-tauri/tauri.conf.json` version.
2. Create and push a tag in the form `v<version>` (example: `v0.1.0`).

Pushing the tag triggers the GitHub Actions release workflow, which builds the Windows bundle and
attaches the installer artifacts to a GitHub Release.

Documentation

- User guide: `docs/USER_GUIDE.md`
- Plugin developer guide (API v1): `docs/PLUGIN_DEVELOPER_GUIDE.md`

Plugin examples

- Demo plugin: `plugin-example/demo/`
- Starter template: `plugin-example/template/`

## License

MIT. See `LICENSE`.
