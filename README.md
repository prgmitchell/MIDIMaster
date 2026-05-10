# MIDIMaster

https://midimaster.app/

MIDIMaster is a Windows desktop app for mapping MIDI controls like faders, knobs,
and buttons to system audio, app audio sessions, audio devices, and supported
integrations.

<img width="1308" height="890" alt="midimaster-night-light" src="https://github.com/user-attachments/assets/80d65d1d-9210-4777-9528-f5b37cf27911" />

## Platform

MIDIMaster currently supports Windows.

## Plugins and the Store

MIDIMaster supports runtime plugins and an in-app Store for integrations. Plugins
can add binding targets, connection UI, runtime behavior, and feedback updates
without rebuilding the app.

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

Prerequisites:

- Rust (stable) and Cargo
- Visual Studio Build Tools / MSVC toolchain
- Tauri CLI v2 (`cargo install tauri-cli --version "^2" --locked`)

Clone and run the app:

```powershell
git clone https://github.com/prgmitchell/MIDIMaster.git
cd MIDIMaster
cargo tauri dev
```

Build a local Windows bundle:

```powershell
cargo tauri build
```

## License

MIT. See `LICENSE`.
