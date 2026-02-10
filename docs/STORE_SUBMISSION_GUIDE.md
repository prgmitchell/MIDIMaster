# Store Submission Guide

MIDIMaster includes an in-app "Store" tab that installs plugins from an official catalog.

Plugins are distributed as a single `.midimaster` package file.

## How to submit a plugin

1. Package your plugin as a `.midimaster` file.
2. Send the file to the maintainer along with:
   - plugin id
   - plugin name
   - version
   - a short description
   - homepage/source URL (recommended)

## What the official Store is

- The official Store is curated and may accept/reject/remove plugins at any time.
- Store downloads are signed. The app verifies signatures using a trusted public key.
- The Store service/catalog and signing keys are maintained separately (not in this repository).

## Review expectations

Submissions are typically evaluated for:

- Safety (no malware, credential theft, obfuscated payloads, or unexpected network behavior)
- Clarity (a clear description and reasonable defaults)
- Stability (does not crash the app or spam the UI/logs)

If your plugin connects to third-party services, clearly document any required permissions,
tokens, or local network access.

## Rights and branding

By submitting a plugin for inclusion in the official Store, you confirm that you have the rights
to distribute the code and any bundled assets (including icons and trademarks).

## Requirements

- `manifest.json` must include:
  - `id`, `name`, `version`, `api_version` (must be `"1"`), `entry`
- The plugin id should be stable and unique
- The entry file should be an ESM module (use `.mjs`)

## Notes

- You can always install plugins manually from a `.midimaster` file even if they are not in the Store.
