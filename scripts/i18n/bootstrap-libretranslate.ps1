param(
  [string]$HostUrl = "http://127.0.0.1:5000",
  [switch]$UpdateModels
)

$ErrorActionPreference = "Stop"

$toolRoot = Join-Path $env:LOCALAPPDATA "MIDIMaster\i18n-tools\libretranslate"
$venv = Join-Path $toolRoot ".venv"
$pythonExe = Join-Path $venv "Scripts\python.exe"
$libreTranslateExe = Join-Path $venv "Scripts\libretranslate.exe"
$stdoutLogPath = Join-Path $toolRoot "libretranslate.out.log"
$stderrLogPath = Join-Path $toolRoot "libretranslate.err.log"
$readyUri = "$HostUrl/languages"

New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

if (-not (Test-Path $pythonExe)) {
  python -m venv $venv
}

& $pythonExe -m pip install --upgrade pip libretranslate

$existing = $null
try {
  $existing = Invoke-RestMethod -Uri $readyUri -TimeoutSec 2
} catch {
  $existing = $null
}

if ($existing) {
  Write-Host "LibreTranslate is already running at $HostUrl"
  exit 0
}

$args = @()
if ($UpdateModels) {
  $args += "--update-models"
}

$process = Start-Process `
  -FilePath $libreTranslateExe `
  -ArgumentList $args `
  -WorkingDirectory $toolRoot `
  -RedirectStandardOutput $stdoutLogPath `
  -RedirectStandardError $stderrLogPath `
  -WindowStyle Hidden `
  -PassThru

Write-Host "Started LibreTranslate process $($process.Id). Waiting for $readyUri ..."

$deadline = (Get-Date).AddMinutes(5)
do {
  Start-Sleep -Seconds 3
  try {
    $languages = Invoke-RestMethod -Uri $readyUri -TimeoutSec 5
    if ($languages) {
      Write-Host "LibreTranslate is ready at $HostUrl"
      Write-Host "Output log: $stdoutLogPath"
      Write-Host "Error log: $stderrLogPath"
      exit 0
    }
  } catch {
    if ($process.HasExited) {
      throw "LibreTranslate exited before becoming ready. See $stderrLogPath"
    }
  }
} while ((Get-Date) -lt $deadline)

throw "Timed out waiting for LibreTranslate. See $stderrLogPath"
