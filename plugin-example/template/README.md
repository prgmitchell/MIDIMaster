# Plugin Starter Template

This folder is a copy/paste starting point for building a new MIDIMaster integration plugin (API v1).

What it includes

- `manifest.json` (API v1)
- `plugin.mjs` (single-file, Blob-import friendly)
- `icon.svg`

How to use

1. Copy this folder into your MIDIMaster plugins directory as a new folder.
2. Rename the folder and update `manifest.json`:
   - `id`
   - `name`
   - `version`
3. Update `plugin.mjs`:
   - Replace the fake connect logic with your integration.
   - Replace `getTargetOptions` with real targets.
   - Implement `onBindingTriggered` to actually control your integration.

Notes

- MIDIMaster loads plugins from the config plugins directory at runtime.
- Keep your plugin entry file self-contained; relative ESM imports are not reliably supported.
