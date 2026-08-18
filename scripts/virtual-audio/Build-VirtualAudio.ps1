[CmdletBinding()]
param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [switch]$Strict,
    [string]$ReleaseVid,
    [string]$ReleasePid
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$workspace = Join-Path $repoRoot "virtual-audio"
$dist = Join-Path $workspace "dist"
$vendor = Join-Path $repoRoot "src-tauri\windows\virtual-audio\vendor"
$manifest = Join-Path $vendor "usbip-win2-0.9.7.7.json"
$usbip = Join-Path $vendor "USBip-0.9.7.7-x64.exe"
$strictMode = [bool]$Strict -or @("1", "true", "yes", "on") -contains ([string]$env:MIDIMASTER_VIRTUAL_AUDIO_STRICT).Trim().ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($ReleaseVid)) { $ReleaseVid = $env:MIDIMASTER_RELEASE_USB_VID }
if ([string]::IsNullOrWhiteSpace($ReleasePid)) { $ReleasePid = $env:MIDIMASTER_RELEASE_USB_PID }

function Convert-HexIdentity([string]$Value, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^0x[0-9a-fA-F]{4}$') {
        throw "$Name must be exactly four hexadecimal digits prefixed by 0x."
    }
    return $Value.Substring(2).ToUpperInvariant()
}

$identityKind = "development"
$vid = "FFFF"
$usbPid = "CA01"
if (-not [string]::IsNullOrWhiteSpace($ReleaseVid) -or -not [string]::IsNullOrWhiteSpace($ReleasePid)) {
    $vid = Convert-HexIdentity $ReleaseVid "ReleaseVid"
    $usbPid = Convert-HexIdentity $ReleasePid "ReleasePid"
    if ($vid -ne "1209") { throw "Public MIDIMaster builds must use the approved pid.codes shared VID 0x1209." }
    if ($usbPid -eq "0000") { throw "ReleasePid cannot be 0x0000." }
    $identityKind = "release"
}
if ($strictMode -and $identityKind -ne "release") {
    throw "Strict packaging requires an assigned release VID/PID. Development identity FFFF:CA01 cannot be shipped."
}

$verifyArgs = @{
    ManifestPath = $manifest
    PayloadPath = $usbip
}
if ($strictMode) {
    $verifyArgs.RequireValidSignature = $true
} else {
    $verifyArgs.AllowMissing = $true
}
$usbipResult = & (Join-Path $PSScriptRoot "Test-UsbipPayload.ps1") @verifyArgs

$oldVid = $env:MIDIMASTER_USB_VID
$oldPid = $env:MIDIMASTER_USB_PID
$env:MIDIMASTER_USB_VID = $vid
$env:MIDIMASTER_USB_PID = $usbPid
try {
    # Cargo writes normal progress messages to stderr. When this script is
    # launched through Windows PowerShell, those successful progress lines are
    # surfaced to the caller as a misleading NativeCommandError. Quiet mode
    # keeps successful builds clean while preserving real compiler errors.
    $cargoArgs = @("build", "--quiet", "--manifest-path", (Join-Path $workspace "Cargo.toml"), "--workspace")
    if ($Configuration -eq "Release") { $cargoArgs += "--release" }
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "Virtual Audio Rust build failed with exit code $LASTEXITCODE." }
} finally {
    $env:MIDIMASTER_USB_VID = $oldVid
    $env:MIDIMASTER_USB_PID = $oldPid
}

$profile = if ($Configuration -eq "Release") { "release" } else { "debug" }
$target = Join-Path $workspace "target\$profile"
New-Item -ItemType Directory -Path $dist -Force | Out-Null

@(
    "midimaster-virtual-audio-service.exe",
    "midimaster-virtual-audio-setup.exe",
    "USBip-0.9.7.7-x64.exe",
    "USBIP-WIN2-LICENSE.txt",
    "THIRD_PARTY_NOTICES.txt",
    "virtual-audio-build.json"
) | ForEach-Object {
    $stale = Join-Path $dist $_
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }
}

Copy-Item -LiteralPath (Join-Path $target "midimaster-virtual-audio-service.exe") -Destination $dist
Copy-Item -LiteralPath (Join-Path $target "midimaster-virtual-audio-setup.exe") -Destination $dist
Copy-Item -LiteralPath (Join-Path $workspace "THIRD_PARTY_NOTICES.txt") -Destination $dist
Copy-Item -LiteralPath (Join-Path $vendor "USBIP-WIN2-LICENSE.txt") -Destination $dist
if ($usbipResult.present) {
    Copy-Item -LiteralPath $usbip -Destination $dist
}

$buildInfo = [ordered]@{
    schema_version = 1
    identity_kind = $identityKind
    vid = "0x$vid"
    pid = "0x$usbPid"
    usbip_payload_present = [bool]$usbipResult.present
    usbip_version = "0.9.7.7"
    usbip_sha256 = "51620fa5f9f8be5932bc9d786deee557ce06d5407a99cab490dcfac71f185fea"
}
$buildJson = $buildInfo | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $dist "virtual-audio-build.json"), $buildJson, $utf8NoBom)
Write-Host "Staged MIDIMaster Virtual Audio ($identityKind $vid`:$usbPid) in $dist"
