# Pinned USBIP payload

Place the official `USBip-0.9.7.7-x64.exe` here before producing a release.
The file is intentionally not downloaded by build scripts and is ignored by
Git. `scripts/virtual-audio/Test-UsbipPayload.ps1` validates the exact byte
length and SHA-256 from `usbip-win2-0.9.7.7.json`.

Do not substitute 0.9.7.8: upstream warns that release may corrupt memory and
cause a BSOD. Any version change requires a new manifest and Windows VM
qualification.
