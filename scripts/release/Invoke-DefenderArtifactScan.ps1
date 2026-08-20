[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue)) {
    throw "Microsoft Defender cmdlets are unavailable; refusing to approve release artifacts without an antivirus scan."
}

$status = Get-MpComputerStatus
if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled) {
    throw "Microsoft Defender Antivirus is not enabled on this runner."
}

$platformRoot = Join-Path $env:ProgramData "Microsoft\Windows Defender\Platform"
$mpCmdRun = Get-ChildItem -LiteralPath $platformRoot -Filter MpCmdRun.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $mpCmdRun) {
    $fallback = Join-Path $env:ProgramFiles "Windows Defender\MpCmdRun.exe"
    if (Test-Path -LiteralPath $fallback -PathType Leaf) {
        $mpCmdRun = Get-Item -LiteralPath $fallback
    }
}
if (-not $mpCmdRun) {
    throw "MpCmdRun.exe was not found; refusing to approve release artifacts without an antivirus scan."
}

Write-Host "Defender definitions: $($status.AntivirusSignatureVersion) ($($status.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('u')))"

foreach ($candidate in $Path) {
    $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    $scanStarted = (Get-Date).AddSeconds(-2)

    & $mpCmdRun.FullName -Scan -ScanType 3 -File $resolved -DisableRemediation
    $scanExitCode = $LASTEXITCODE
    if ($scanExitCode -ne 0) {
        throw "Microsoft Defender scan failed or detected malware in '$resolved' (exit code $scanExitCode)."
    }

    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Microsoft Defender removed or quarantined '$resolved'."
    }

    $detections = Get-MpThreatDetection -ErrorAction Stop | Where-Object {
        $_.InitialDetectionTime -ge $scanStarted -and
        (($_.Resources | ForEach-Object { [string]$_ }) -match [regex]::Escape($resolved))
    }
    if ($detections) {
        $threatIds = ($detections | Select-Object -ExpandProperty ThreatID -Unique) -join ", "
        throw "Microsoft Defender reported a detection for '$resolved' (threat IDs: $threatIds)."
    }

    [pscustomobject]@{
        path = $resolved
        sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
        defender_signature_version = [string]$status.AntivirusSignatureVersion
        scan = "clean"
    }
}
