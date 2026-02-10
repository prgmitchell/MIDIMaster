# MIDIMaster Plugin Developer Guide (API v1)

This document is the complete reference for writing MIDIMaster plugins.

It covers:

- What language to use
- How plugins are loaded and installed
- Manifest format
- The full plugin API surface (context `ctx`)
- How to build targets and nested menus
- How to implement connection UI
- How to send feedback (UI + OSD + motor faders)
- How to persist per-profile settings
- WebSocket bridge usage (custom headers supported)

If you are a user, see `docs/USER_GUIDE.md`.

## 1. Plugin Runtime and Language

### Language

- JavaScript
- ESM modules (ECMAScript modules)

### File type

- Use `.mjs` for your entry file.

### Environment

Plugins run in MIDIMaster's WebView (Tauri frontend). You have access to:

- Standard browser APIs (DOM, timers, etc.)
- The MIDIMaster plugin API (`ctx`), which wraps important app features

### Important: Module Imports

MIDIMaster loads your plugin by reading the entry file as text and importing it via a Blob URL.

Because of this, relative imports like:

```js
import "./other.mjs";
```

are not reliable.

Best practice:

- Bundle your plugin into a single `plugin.mjs` file.
- Or avoid ESM imports and keep everything in the entry file.

## 2. Plugin Installation Layout

Plugins are installed into the app config directory:

`<app_config_dir>/plugins/<plugin_id>/`

Minimum required files:

```
<plugin_id>/
  manifest.json
  plugin.mjs
```

You may include additional assets:

```
<plugin_id>/
  manifest.json
  plugin.mjs
  icon.svg
  assets/
    logo.png
```

## 3. Manifest Format

`manifest.json` example:

```json
{
  "id": "demo",
  "name": "Demo Integration",
  "version": "0.1.0",
  "api_version": "1",
  "entry": "plugin.mjs",
  "icon": "icon.svg"
}
```

Fields:

- `id` (string): unique id for this plugin. Should match your folder name.
- `name` (string): shown in Plugins UI and other UI.
- `version` (string): informational.
- `api_version` (string): must be `"1"`.
- `entry` (string): entry file path relative to the plugin folder.
- `icon` (string, optional): relative path to a plugin icon.

Security constraints:

- MIDIMaster forbids absolute paths and `..` traversal when reading plugin files.

## 4. Required Plugin Export

Your plugin must export either:

- `export async function activate(ctx) { ... }`
- or a default export function (treated like `activate`)

Example:

```js
export async function activate(ctx) {
  // register integration and/or connection UI
}
```

## 5. High-Level Concepts

### Integration

An integration is the thing that provides targets and handles binding triggers.

Each integration is identified by a stable `integration_id` string. Usually this is the same as your plugin id.

Bindings store targets in this shape:

```js
{
  Integration: {
    integration_id: "my_plugin",
    kind: "channel",
    data: {
      // stable identifiers
      channel_id: "abc123",

      // display metadata (stored by MIDIMaster)
      label: "My Channel",
      icon_data: "data:image/svg+xml;base64,..." // or "assets/..."
    }
  }
}
```

### Plugin Tab (UI)

Plugins can register a tab inside the Plugins modal. The plugin fully owns the UI in that tab.

### Feedback

To keep UI, OSD, and motor faders in sync, plugins call `ctx.feedback.set(...)`.

## 6. The Plugin Context (`ctx`) API

Your `activate(ctx)` receives a context object.

### 6.1 `ctx.registerIntegration(integration)`

Registers an integration handler.

```js
ctx.registerIntegration({
  id: "my_plugin",
  name: "My Plugin",
  icon_data: null,

  describeTarget: (target) => ({ label: "...", icon_data: null, ghost: false }),

  getTargetOptions: async ({ controlType, nav } = {}) => {
    return [
      {
        label: "Target name",
        icon_data: null,
        target: {
          Integration: {
            integration_id: "my_plugin",
            kind: "channel",
            data: { channel_id: "abc" }
          }
        }
      }
    ];
  },

  onBindingTriggered: async ({ binding_id, action, value, target }) => {
    // ...perform integration action...
  }
});
```

#### `describeTarget(target)`

Purpose:

- Provide a label/icon for a stored target.
- Provide availability state via `ghost`.

Input:

- `target`: typically `{ Integration: { ... } }` or `{ integration: { ... } }`

Output:

```js
{ label: string, icon_data?: string|null, ghost?: boolean }
```

Guidelines:

- Prefer `Integration.data.label` and `Integration.data.icon_data` when present.
- If disconnected, return `ghost: true`. MIDIMaster will grey the target.
- Do NOT permanently write availability text into stored labels.
- If your connection state changes, call `ctx.app.invalidateBindingsUI()` so the main list updates.

#### `getTargetOptions({ controlType, nav })`

Purpose:

- Provide target choices for the binding target picker.

Parameters:

- `controlType`: typically `"fader"` or `"button"`
- `nav`: optional object for nested menus

Return:

- Array of option objects.

Option shapes:

1) Selectable target:

```js
{
  label: "My Target",
  icon_data: "data:image/svg+xml;base64,..." | "assets/MyLogo.png" | null,
  target: {
    Integration: {
      integration_id: "my_plugin",
      kind: "thing",
      data: { id: "123" }
    }
  }
}
```

2) Navigation entry (nested menu):

```js
{
  label: "Go deeper",
  nav: { screen: "sub", some_id: "xyz" },
  icon_data: null
}
```

3) Placeholder (non-selectable informational row):

```js
{ label: "Loading...", kind: "placeholder", ghost: true }
```

Notes:

- MIDIMaster stores `label` and `icon_data` from the chosen option into `Integration.data.label/icon_data` automatically.
- For best UX, include `icon_data` consistently.

#### `onBindingTriggered({ binding_id, action, value, target })`

Purpose:

- Execute the integration behavior when a binding is used.

Inputs:

- `binding_id` identifies which binding fired.
- `action` is a string. Common values:
  - `"Volume"`
  - `"ToggleMute"`
- `value` is usually 0..1.
- `target` is a plain integration target object:

```js
{
  integration_id: "my_plugin",
  kind: "thing",
  data: { ... }
}
```

Expected behavior:

- Perform the requested action.
- Call `ctx.feedback.set(binding_id, ...)` to keep the UI and controller synchronized.

### 6.2 `ctx.connections.registerTab(tab)`

Registers a Plugins modal tab.

```js
ctx.connections.registerTab({
  id: "my_plugin",
  name: "My Plugin",
  icon_data: "data:image/svg+xml;base64,..." | null,
  order: 50,
  mount: (container) => {
    container.innerHTML = "...";
  },
  unmount: (container) => {
    // optional cleanup
  }
});
```

UI guidance:

- Use existing app CSS class names so your tab matches the app styling.
- Include a Connect/Disconnect button if you have a real connection.
- If you support auto-connect, include a checkbox and save it in `ctx.profile`.

### 6.3 `ctx.profile` (Per-profile plugin settings)

Each profile stores plugin settings under a profile-level `plugin_settings` map.

API:

- `ctx.profile.get()` -> object
- `await ctx.profile.set(object)`
- `ctx.profile.onChanged(handler)`

Example:

```js
const settings = ctx.profile.get();
const autoConnect = settings.auto_connect ?? true;

await ctx.profile.set({ ...settings, auto_connect: false });
```

Recommended:

- Keep settings small and JSON-serializable.
- If you store secrets (tokens), treat profiles as sensitive local files.

### 6.4 `ctx.bindings` (Read bindings and react to changes)

API:

- `ctx.bindings.getAll()` -> array
- `ctx.bindings.onChanged(handler)`

Use this to:

- Discover which targets are actually bound
- Perform sync for only those targets

### 6.5 `ctx.feedback.set(bindingId, value, action, opts)`

This is how plugins update:

- MIDIMaster UI (sliders, mute icons)
- OSD
- MIDI feedback (motor faders)

```js
await ctx.feedback.set(bindingId, 0.75, "Volume");
await ctx.feedback.set(bindingId, 1.0, "ToggleMute");
```

Silent updates:

```js
await ctx.feedback.set(bindingId, 0.75, "Volume", { silent: true });
```

Use `silent: true` for:

- Startup sync
- Reconnect sync
- Motor fader alignment

### 6.6 `ctx.ws` (WebSocket bridge)

Use this when you need custom headers or consistent backend-managed sockets.

```js
const id = await ctx.ws.open("ws://127.0.0.1:1234", { Origin: "my-origin" }, 750);

ctx.ws.onMessage(id, (msg) => {
  if (msg.type === "text") {
    console.log(msg.data);
  }
});

await ctx.ws.send(id, JSON.stringify({ hello: "world" }));
await ctx.ws.close(id);
```

Message handler receives:

- `{ id, type: "text", data: string }`
- `{ id, type: "binary", data: base64String }`

### 6.7 `ctx.assets` (Read plugin assets)

- `await ctx.assets.readBase64(relPath)` -> base64 string
- `await ctx.assets.readDataUrl(relPath, mime)` -> `data:<mime>;base64,...`

Example:

```js
const icon = await ctx.assets.readDataUrl("icon.svg", "image/svg+xml");
```

### 6.8 `ctx.tauri` (Low-level)

Advanced escape hatch:

- `ctx.tauri.invoke(name, args)`
- `ctx.tauri.listen(eventName, handler)`

Prefer stable APIs (`ws`, `feedback`, etc.) when possible.

### 6.9 `ctx.app.invalidateBindingsUI()`

If your plugin's connection/availability state changes, call:

```js
ctx.app.invalidateBindingsUI();
```

This forces the main binding list to re-render so unavailable/available styling updates immediately.

## 7. Icon Formats (`icon_data`)

MIDIMaster accepts these forms:

- Data URL: `data:image/svg+xml;base64,...`
- Asset path inside the plugin: `assets/MyLogo.png` (your plugin must ensure the asset is readable/usable)
- Raw base64 PNG data (MIDIMaster will treat it as PNG and prefix `data:image/png;base64,`)

Recommended:

- Use `ctx.assets.readDataUrl(...)` and supply a data URL.

## 8. Availability and "Unavailable" UI

MIDIMaster will grey a target when `ghost: true`.

Best practice:

- `describeTarget` should return `ghost: true` when disconnected.
- Do not mutate stored labels to include "Unavailable".
- Call `ctx.app.invalidateBindingsUI()` on connect/disconnect.

## 9. Connection Design Pattern (Recommended)

If your integration is a local websocket service:

1. Add `Auto connect` checkbox stored in `ctx.profile`.
2. Implement a background loop:
   - If `auto_connect` and not connected, attempt to connect.
3. Provide a Connect/Disconnect button:
   - Connect triggers a connection attempt even if auto-connect is off.
   - Disconnect closes the socket and sets an internal `disconnectedByUser` flag so you do not reconnect immediately.
4. On connect:
   - Load initial state
   - Call `ctx.feedback.set(..., { silent: true })` for all bound targets
5. On disconnect:
   - Return `ghost: true` from `describeTarget`
   - Optionally drive offline feedback (for motor faders) if that matches the UX you want

## 10. Example Plugin

See the demo plugin:

- `plugin-example/demo/manifest.json`
- `plugin-example/demo/plugin.mjs`

It demonstrates:

- A Connections tab
- An integration with a target
- Feedback echoing

## 11. Packaging as a .midimaster File

MIDIMaster supports installing plugins from a single `.midimaster` file.

### Format

A `.midimaster` file is a ZIP archive with the extension renamed to `.midimaster`.

The ZIP should contain `manifest.json` at the archive root, plus all plugin files referenced by the manifest.

Example archive contents:

```
manifest.json
plugin.mjs
icon.svg
assets/logo.png
```

MIDIMaster also tolerates packages where everything is inside one top-level folder, as long as that folder contains `manifest.json`.

### Creating a Package

1. Ensure your plugin folder contains at least:
   - `manifest.json`
   - the entry file referenced by `manifest.json` (`entry`, usually `plugin.mjs`)
2. Create a ZIP of the folder contents.
3. Rename the `.zip` to `.midimaster`.

### Installing for Testing

In MIDIMaster:

`Plugins -> Installed -> Install Plugin...` and select your `.midimaster` file.

### Starter Template

Use the starter template:

- `plugin-example/template/`

## 12. Debugging

Tips:

- Use `console.error` / `console.log` in your plugin.
- Keep connection state in module scope.
- Debounce UI refreshes; MIDIMaster already debounces `invalidateBindingsUI`.

Common mistakes:

- Returning targets without `Integration.integration_id`
- Not calling `ctx.feedback.set` after handling a trigger
- Putting secrets in source control (tokens in profile settings)

## 13. Publishing Checklist

Use this checklist when you are preparing a plugin to share with other users.

### Packaging

- Single entry module:
  - Bundle into one `plugin.mjs` (recommended).
  - Avoid relative ESM imports; Blob-based module loading does not reliably resolve `./foo.mjs`.
- Include `manifest.json` and keep paths correct:
  - `entry` must exist and be readable.
  - `api_version` must be `"1"`.
- Keep file paths portable:
  - Use forward slashes in manifest paths.
  - Do not rely on OS-specific absolute paths.

### Versioning and Compatibility

- Increment `version` on every release.
- Keep your `integration_id` stable (usually equal to manifest `id`).
- Do not change target identity fields in `Integration.data` lightly.
  - MIDIMaster uses stable identifiers to match stored targets.
  - If you must change identifiers, implement back-compat in your `describeTarget` and `onBindingTriggered`.

### Targets and Metadata

- Always return `label` and `icon_data` for targets when possible.
  - MIDIMaster stores `Integration.data.label` and `Integration.data.icon_data` so targets keep their name/icon even when the plugin is missing.
- Avoid persisting ephemeral status text:
  - Use `ghost: true` for disconnected state.
  - Do not write "(Unavailable)" into stored labels.

### Plugins UX

- Provide a Plugins tab if your plugin needs configuration or connection.
- Include a Connect/Disconnect button if you have a real socket/session.
- If you support auto-connect:
  - Store it in `ctx.profile` so it is per-profile.
  - Ensure manual Disconnect prevents immediate auto-reconnect.

### Feedback Behavior (UI + OSD + Motor Faders)

- After any successful action, call `ctx.feedback.set(binding_id, value, action)`.
- On connect or reconnect:
  - Sync all bound targets via `ctx.feedback.set(..., { silent: true })`.
  - This prevents OSD spam during startup.
- If your integration goes offline and you want motor faders to reflect it:
  - Optionally drive an offline state (for example, volume -> 0) using silent feedback.

### Performance

- In `getTargetOptions`, avoid heavy calls on every open:
  - Cache lists where possible.
  - Use `nav` to fetch deeper lists only when needed.
- Debounce UI updates:
  - Call `ctx.app.invalidateBindingsUI()` on connection state changes, not on every message.

### Security

- Treat `ctx.profile` as sensitive storage.
  - Do not log tokens.
  - Avoid embedding secrets in your plugin source.
- Only request the minimum permissions you need.

### Test Matrix

- Fresh install (no settings yet)
- Profile switching (settings should follow the profile)
- Plugin missing (targets should display label/icon via stored metadata and appear unavailable)
- Disconnect/reconnect behavior
- Startup auto-connect on/off
