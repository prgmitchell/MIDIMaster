# MIDIMaster locale translation

`translate-locales.mjs` updates `src/locales/*.json` from `src/locales/en.json`.

It translates missing English fallback strings and strings whose English source changed. Existing non-English strings without metadata are treated as hand edits and adopted, so manual cleanup is preserved.

## LibreTranslate

Use this command after any UI text change. It starts LibreTranslate if needed,
translates pending strings, validates every catalog, checks that every used key
exists in English, verifies there is no pending translation work, and scans for
hardcoded frontend text:

```powershell
.\scripts\i18n\sync-locales.ps1
```

Use `-Force` to regenerate all target catalogs.

## LibreTranslate

The sync command uses the recommended free local provider. It installs
LibreTranslate into `$env:LOCALAPPDATA\MIDIMaster\i18n-tools` and starts a local
server automatically. To run the provider manually:

```powershell
.\scripts\i18n\bootstrap-libretranslate.ps1
$env:I18N_PROVIDER = "libretranslate"
node scripts/i18n/translate-locales.mjs
node scripts/i18n/validate-locales.mjs
node scripts/i18n/translate-locales.mjs --dry-run --fail-on-pending
node scripts/i18n/scan-unlocalized.mjs
```

Use a different endpoint with:

```powershell
$env:LIBRETRANSLATE_URL = "http://127.0.0.1:5000"
```

## Argos Translate

Offline Python provider:

```powershell
python -m pip install argostranslate
$env:I18N_PROVIDER = "argos"
node scripts/i18n/translate-locales.mjs
node scripts/i18n/validate-locales.mjs
```

Set `ARGOS_PYTHON` if the desired Python executable is not `python`.

## OpenAI fallback

```powershell
$env:I18N_PROVIDER = "openai"
$env:OPENAI_API_KEY = "..."
node scripts/i18n/translate-locales.mjs
```

## Options

- `--force`: retranslates every string, including hand-edited strings.
- `--dry-run`: reports pending work without calling the translation provider or writing files.
- `--fail-on-pending`: exits non-zero during `--dry-run` if any catalog needs translation.
- `--skip-readiness-check`: skips the LibreTranslate `/languages` check.

CI runs validation, pending-translation detection, and hardcoded-string scanning,
so new user-facing text cannot merge unless the locale catalogs are current.
