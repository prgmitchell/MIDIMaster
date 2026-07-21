[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApplicationPath,
    [string]$FixturePath,
    [string]$ScenarioId = "startup-cold-b250-p1-0.6mb",
    [string]$Variant = "current",
    [ValidateRange(1, 600)]
    [int]$DurationSeconds = 30,
    [string]$OutputDirectory = "perf-results/traces"
)

$ErrorActionPreference = "Stop"
$wpr = Get-Command wpr.exe -ErrorAction SilentlyContinue
if (-not $wpr) { throw "wpr.exe was not found. Install the Windows Performance Toolkit from the Windows ADK." }
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$etlPath = Join-Path $outputRoot "$Variant-$ScenarioId-$stamp.etl"

& $wpr.Source -cancel 2>$null | Out-Null
try {
    & $wpr.Source -start GeneralProfile -filemode
    if ($LASTEXITCODE -ne 0) { throw "WPR failed to start. Run this shell as Administrator." }
    $arguments = @{
        ApplicationPath = $ApplicationPath
        ScenarioId = $ScenarioId
        Variant = $Variant
        DurationSeconds = $DurationSeconds
        OutputDirectory = $OutputDirectory
    }
    if ($FixturePath) { $arguments.FixturePath = $FixturePath }
    & (Join-Path $PSScriptRoot "Invoke-PerfRun.ps1") @arguments
    & $wpr.Source -stop $etlPath "MIDIMaster local performance audit"
    if ($LASTEXITCODE -ne 0) { throw "WPR failed to save $etlPath" }
    Write-Host "Wrote private ETW trace: $etlPath"
}
catch {
    & $wpr.Source -cancel 2>$null | Out-Null
    throw
}
