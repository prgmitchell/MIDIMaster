[CmdletBinding()]
param(
    [string]$ManifestPath,
    [string]$PayloadPath,
    [switch]$AllowMissing,
    [switch]$RequireValidSignature
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $PSScriptRoot "..\..\src-tauri\windows\virtual-audio\vendor\usbip-win2-0.9.7.7.json"
}
$manifestPathResolved = [System.IO.Path]::GetFullPath($ManifestPath)
if (-not (Test-Path -LiteralPath $manifestPathResolved -PathType Leaf)) {
    throw "USBIP manifest not found: $manifestPathResolved"
}

$manifest = Get-Content -LiteralPath $manifestPathResolved -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($PayloadPath)) {
    $PayloadPath = Join-Path (Split-Path -Parent $manifestPathResolved) $manifest.file
}
$payloadPathResolved = [System.IO.Path]::GetFullPath($PayloadPath)

if (-not (Test-Path -LiteralPath $payloadPathResolved -PathType Leaf)) {
    if ($AllowMissing) {
        [pscustomobject]@{
            present = $false
            valid = $false
            version = [string]$manifest.version
            path = $payloadPathResolved
            reason = "missing"
        }
        exit 0
    }
    throw "Pinned USBIP payload is missing: $payloadPathResolved. Supply the official 0.9.7.7 x64 installer; this script never downloads it."
}

$item = Get-Item -LiteralPath $payloadPathResolved
$expectedSize = [int64]$manifest.size
if ($item.Length -ne $expectedSize) {
    throw "USBIP payload size mismatch: expected $expectedSize bytes, got $($item.Length)."
}

$actualHash = (Get-FileHash -LiteralPath $payloadPathResolved -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedHash = ([string]$manifest.sha256).ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
    throw "USBIP payload SHA-256 mismatch: expected $expectedHash, got $actualHash."
}

$signatureStatus = "NotChecked"
$signer = $null
if ($RequireValidSignature) {
    $signature = Get-AuthenticodeSignature -LiteralPath $payloadPathResolved
    $signatureStatus = [string]$signature.Status
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "USBIP payload Authenticode signature is not valid: $signatureStatus."
    }
    $signer = $signature.SignerCertificate.Subject
}

[pscustomobject]@{
    present = $true
    valid = $true
    version = [string]$manifest.version
    path = $payloadPathResolved
    size = $item.Length
    sha256 = $actualHash
    signature = $signatureStatus
    signer = $signer
}
