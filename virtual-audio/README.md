# MIDIMaster Virtual Audio

This standalone Rust workspace contains the privileged pieces of MIDIMaster
Virtual Audio. It is deliberately separate from the Tauri application so the
app remains a per-user install while the service is installed under Program
Files by an explicitly elevated helper.

The service exposes one fixed USB Audio Class 1 device through a localhost-only
USB/IP 1.1.1 server. Windows' signed in-box `usbaudio.sys` supplies the audio
endpoint; the unchanged upstream `usbip-win2` package supplies only the virtual
USB transport.

Development builds use the experimental VID/PID `FFFF:CA01`. A public build is
blocked until an assigned pid.codes PID is supplied to the build script with
`-ReleaseVid 0x1209 -ReleasePid 0xNNNN`.

See [PACKAGING.md](PACKAGING.md) for the deterministic dependency and release
workflow.
