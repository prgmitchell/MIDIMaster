# Virtual Audio packaging

## Required upstream package

The repository does not commit the 33 MB USBIP installer, and local build
scripts never fetch it. Before a local release bundle can be built, place the
official upstream file at:

`src-tauri/windows/virtual-audio/vendor/USBip-0.9.7.7-x64.exe`

Run:

```powershell
scripts/virtual-audio/Build-VirtualAudio.ps1 -Configuration Release -Strict -ReleaseVid 0x1209 -ReleasePid 0xNNNN
```

`-Strict` refuses to stage the installer unless its byte length, SHA-256, and
upstream Authenticode signature match the committed policy. The release
workflow supplies the assigned identity through `MIDIMASTER_RELEASE_USB_VID`
and `MIDIMASTER_RELEASE_USB_PID`. It never downloads a replacement. This is
also the release-CI gate.

GitHub release CI explicitly downloads that exact `v.0.9.7.7` asset URL, then
applies the same byte-length, hash, and Authenticode checks before staging. It
never resolves or downloads a moving `latest` release.

The assigned VID/PID must be stable before publishing. The build script passes
the identity through compile-time environment variables; omitting it produces
an explicitly development-only `FFFF:CA01` service.

## Installed layout

The normal per-user Tauri bundle contains a `virtual-audio` resource directory.
The elevated setup helper copies only the service and notices to:

`%ProgramFiles%\MIDIMaster\Virtual Audio`

The upstream USBIP package remains byte-for-byte unchanged, retains its own
signature, and appears separately in Windows Installed Apps. Removing the
MIDIMaster component never removes this shared driver.

## Exit codes

The setup helper writes a single JSON result to stdout and uses these stable
exit codes: `0` success, `3010` restart required, `20` elevation required, `21`
payload invalid, `22` driver installation failed, `23` unsafe USBIP 0.9.7.8,
`24` unsupported USBIP version, and `25` service operation failed.
