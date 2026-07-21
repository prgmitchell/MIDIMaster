[CmdletBinding()]
param(
    [switch]$Bundle,
    [ValidateSet("nsis", "msi")]
    [string]$BundleType = "nsis",
    [ValidateSet("z", "3")]
    [string]$OptimizationLevel = "z"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../../..")).Path
$tauriRoot = Join-Path $repoRoot "src-tauri"
$overlay = Join-Path $repoRoot "scripts/perf/config/tauri.perf.conf.json"
$oldDebug = $env:CARGO_PROFILE_RELEASE_DEBUG
$oldStrip = $env:CARGO_PROFILE_RELEASE_STRIP
$oldOptLevel = $env:CARGO_PROFILE_RELEASE_OPT_LEVEL
try {
    # Keep release code generation while retaining the PDB and line information.
    $env:CARGO_PROFILE_RELEASE_DEBUG = "2"
    $env:CARGO_PROFILE_RELEASE_STRIP = "false"
    $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = $OptimizationLevel
    Push-Location $tauriRoot
    try {
        $arguments = @("tauri", "build", "--features", "perf-audit", "--config", $overlay)
        if ($Bundle) { $arguments += @("--bundles", $BundleType) }
        else { $arguments += "--no-bundle" }
        & cargo @arguments
        if ($LASTEXITCODE -ne 0) { throw "Audit build failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:CARGO_PROFILE_RELEASE_DEBUG = $oldDebug
    $env:CARGO_PROFILE_RELEASE_STRIP = $oldStrip
    $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = $oldOptLevel
}

Write-Host "Audit executable: $(Join-Path $tauriRoot 'target/release/midimaster.exe')"
Write-Host "Audit symbols: $(Join-Path $tauriRoot 'target/release/midimaster.pdb')"
$auditExecutable = Join-Path $tauriRoot "target/release/midimaster.exe"
$auditMarker = Join-Path $tauriRoot "target/release/midimaster.perf-audit.json"
$marker = [ordered]@{
    schema_version = "1.0.0"
    feature = "perf-audit"
    executable_sha256 = (Get-FileHash -LiteralPath $auditExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    built_at = [DateTime]::UtcNow.ToString("o")
    optimization_level = $OptimizationLevel
    local_only = $true
}
$markerJson = $marker | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($auditMarker, "$markerJson`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Audit safety marker: $auditMarker"
