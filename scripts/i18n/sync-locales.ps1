param(
  [switch]$Force,
  [switch]$SkipBootstrap
)

$ErrorActionPreference = "Stop"

if (-not $SkipBootstrap) {
  & "$PSScriptRoot\bootstrap-libretranslate.ps1"
}

$env:I18N_PROVIDER = "libretranslate"

$translateArgs = @("scripts/i18n/translate-locales.mjs")
if ($Force) {
  $translateArgs += "--force"
}

node @translateArgs
node scripts/i18n/validate-locales.mjs
node scripts/i18n/translate-locales.mjs --dry-run --fail-on-pending
node scripts/i18n/scan-unlocalized.mjs

Write-Host "[i18n] locale catalogs are synchronized."
