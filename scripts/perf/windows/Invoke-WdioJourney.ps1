[CmdletBinding()]
param(
    [string]$ApplicationPath = "src-tauri/target/release/midimaster.exe",
    [string]$FixturePath,
    [string]$Journey = "all",
    [string]$ScenarioId = "interaction-webdriver",
    [string]$Variant = "current",
    [string]$RunId,
    [string]$OutputDirectory = "perf-results/webdriver",
    [switch]$AutoInstallDriver,
    [switch]$AllowUnverifiedExecutable,
    [switch]$PreserveSandbox
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../../..")).Path
$application = (Resolve-Path -LiteralPath (Join-Path (Get-Location) $ApplicationPath)).Path
if ([System.IO.Path]::GetExtension($application) -ne ".exe") {
    throw "ApplicationPath must identify a Windows .exe: $application"
}
$processName = [System.IO.Path]::GetFileNameWithoutExtension($application)
if (@(Get-Process -Name $processName -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "An existing $processName process is running. Close it before starting an isolated WebdriverIO audit."
}

$runId = if ([string]::IsNullOrWhiteSpace($RunId)) { [Guid]::NewGuid().ToString("N") } else { $RunId.Trim() }
if ($runId -notmatch '^[A-Za-z0-9._-]{1,80}$') {
    throw "RunId may contain only letters, numbers, dot, underscore, and hyphen (maximum 80 characters)."
}
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
$runOutput = Join-Path $outputRoot $runId
[System.IO.Directory]::CreateDirectory($runOutput) | Out-Null
$sandboxParent = Join-Path ([System.IO.Path]::GetTempPath()) "MIDIMaster-perf-webdriver"
$sandboxRoot = Join-Path $sandboxParent $runId
[System.IO.Directory]::CreateDirectory($sandboxRoot) | Out-Null

function Assert-ChildPath([string]$Parent, [string]$Child) {
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childFull = [System.IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing operation outside $Parent`: $Child"
    }
}

$environmentNames = @(
    "MIDIMASTER_PERF_APPLICATION",
    "MIDIMASTER_PERF_APP_DATA_DIR",
    "MIDIMASTER_PERF_WEBVIEW_DATA_DIR",
    "MIDIMASTER_PERF_RESULTS_DIR",
    "MIDIMASTER_PERF_RUN_ID",
    "MIDIMASTER_PERF_SCENARIO_ID",
    "MIDIMASTER_PERF_VARIANT",
    "MIDIMASTER_PERF_NETWORK_MODE",
    "MIDIMASTER_PERF_JOURNEY",
    "MIDIMASTER_PERF_AUTO_INSTALL_DRIVER",
    "MIDIMASTER_PERF_ALLOW_UNVERIFIED",
    "WEBVIEW2_USER_DATA_FOLDER"
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process") }

try {
    if ([string]::IsNullOrWhiteSpace($FixturePath)) {
        $generatedRoot = Join-Path $sandboxRoot "generated-fixture"
        & node (Join-Path $repoRoot "scripts/perf/generate-fixtures.mjs") --output $generatedRoot --bindings 500 --profiles 10 --shapes light --plugins all
        if ($LASTEXITCODE -ne 0) { throw "Fixture generator failed with exit code $LASTEXITCODE" }
        $fixtureRoot = Join-Path $generatedRoot "b500-p10-light-plugins-all"
    }
    else {
        $fixtureRoot = (Resolve-Path -LiteralPath $FixturePath).Path
    }
    $fixtureManifest = Join-Path $fixtureRoot "fixture.json"
    $fixtureAppData = Join-Path $fixtureRoot "app-data/MIDIMaster"
    if (-not (Test-Path -LiteralPath $fixtureManifest -PathType Leaf) -or -not (Test-Path -LiteralPath $fixtureAppData -PathType Container)) {
        throw "FixturePath must contain fixture.json and app-data/MIDIMaster: $fixtureRoot"
    }

    $isolatedAppData = Join-Path $sandboxRoot "app-data/MIDIMaster"
    $isolatedWebView = Join-Path $sandboxRoot "webview2-data"
    [System.IO.Directory]::CreateDirectory($isolatedAppData) | Out-Null
    [System.IO.Directory]::CreateDirectory($isolatedWebView) | Out-Null
    Get-ChildItem -LiteralPath $fixtureAppData -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $isolatedAppData -Recurse -Force
    }

    $manifest = [ordered]@{
        schema_version = "1.0.0"
        run_id = $runId
        scenario_id = $ScenarioId
        variant = $Variant
        journey = $Journey
        fixture = Get-Content -LiteralPath $fixtureManifest -Raw | ConvertFrom-Json
        created_at = [DateTime]::UtcNow.ToString("o")
        local_only = $true
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $runOutput "run.json"),
        "$(($manifest | ConvertTo-Json -Depth 10))`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    $env:MIDIMASTER_PERF_APPLICATION = $application
    $env:MIDIMASTER_PERF_APP_DATA_DIR = $isolatedAppData
    $env:MIDIMASTER_PERF_WEBVIEW_DATA_DIR = $isolatedWebView
    $env:MIDIMASTER_PERF_RESULTS_DIR = $runOutput
    $env:MIDIMASTER_PERF_RUN_ID = $runId
    $env:MIDIMASTER_PERF_SCENARIO_ID = $ScenarioId
    $env:MIDIMASTER_PERF_VARIANT = $Variant
    $env:MIDIMASTER_PERF_NETWORK_MODE = "offline"
    $env:MIDIMASTER_PERF_JOURNEY = $Journey
    $env:MIDIMASTER_PERF_AUTO_INSTALL_DRIVER = if ($AutoInstallDriver) { "1" } else { "0" }
    $env:MIDIMASTER_PERF_ALLOW_UNVERIFIED = if ($AllowUnverifiedExecutable) { "1" } else { "0" }
    $env:WEBVIEW2_USER_DATA_FOLDER = $isolatedWebView

    Push-Location $repoRoot
    try {
        & npm.cmd run perf:webdriver
        if ($LASTEXITCODE -ne 0) { throw "WebdriverIO journey failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
    Write-Host "WebdriverIO journey completed. Results: $runOutput"
}
finally {
    foreach ($name in $environmentNames) {
        [System.Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
    }
    if (-not $PreserveSandbox -and (Test-Path -LiteralPath $sandboxRoot)) {
        Assert-ChildPath $sandboxParent $sandboxRoot
        Remove-Item -LiteralPath $sandboxRoot -Recurse -Force
    }
    elseif ($PreserveSandbox) {
        Write-Host "Preserved disposable sandbox: $sandboxRoot"
    }
}
