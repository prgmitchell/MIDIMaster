# Virtual Audio build scripts

- `Test-UsbipPayload.ps1` verifies the pinned upstream installer without ever
  downloading or modifying it.
- `Build-VirtualAudio.ps1` builds the standalone service/helper and stages the
  resource directory consumed by the Tauri NSIS bundle.

Release automation must call the build script with `-Strict` and the assigned
pid.codes identity before invoking `cargo tauri build`.

