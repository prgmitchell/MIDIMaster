# MIDIMaster User Guide

This guide explains how to set up MIDIMaster, create bindings, use Profiles, and manage integrations (plugins).

If you are a plugin author, see `docs/PLUGIN_DEVELOPER_GUIDE.md`.

## What MIDIMaster Does

MIDIMaster binds controls on your MIDI device (faders, knobs, buttons) to targets such as:

- `Master` volume
- `Focus` (the currently focused application/session)
- Per-application audio sessions
- Playback / recording devices
- Integrations provided by plugins (OBS Studio, Wave Link, and third-party integrations)

When a target changes, MIDIMaster can send feedback back to your MIDI controller (for motorized faders, LEDs, etc.).

## First-Time Setup

### 1) Choose MIDI Input and Output

1. Open MIDIMaster.
2. On the setup screen, pick:
   - MIDI Input (the device you move)
   - MIDI Output (the device MIDIMaster sends feedback to)
3. Click `Connect`.

Notes:

- Motorized faders require an output device.
- If you pick the wrong output, MIDIMaster may not be able to move faders/LEDs.

### 2) Pick a Profile

Profiles store:

- Your bindings list and order
- OSD settings
- Plugin settings (for example, integration auto-connect)

The Profiles dropdown shows the active profile.

## Bindings

Each binding links one MIDI control to one target (plus an action). Bindings are listed in the main table.

### Creating a Binding

1. Click `+ Create binding`.
2. Use MIDI learn (if enabled in your build) or manually choose a control.
3. Choose:
   - Target (Master / Focus / Application / Device / Integration)
   - Mode
   - Action (for button bindings)

### Reordering Bindings

You can drag bindings to reorder them. The order is saved to your profile.

### Modes

- `Absolute`:
  - Fader position maps directly to volume (0.0 to 1.0).
- `Relative`:
  - Control sends increments/decrements (useful for endless encoders).

### Actions (Buttons)

Buttons typically support:

- `Trigger` (sends a value to the target)
- `Toggle Mute`

Integrations may interpret actions differently depending on the plugin.

## Targets

### Built-in Targets

- `Master`: system master volume
- `Focus`: the currently focused session
- `Applications`: discovered audio sessions
- `Playback Devices` / `Recording Devices`

If an application or device disappears, MIDIMaster will show an unavailable entry (greyed).

### Integration Targets (Plugins)

Integrations show up in the target picker under an `Integrations` section.

Examples:

- OBS Studio audio input volume
- Wave Link channel or mix volume

Integrations are implemented by plugins and can be installed/uninstalled without rebuilding MIDIMaster.

## Plugins (Integrations)

Open the Plugins modal (top-right icon).

Each plugin can add its own Plugins tab. The tab can include:

- Connection status
- Connect / Disconnect
- Auto-connect
- Settings fields (host, port, token, etc.)

### Connect / Disconnect

- `Connect` establishes the integration connection and loads targets.
- `Disconnect` intentionally disconnects. Integrations should stop reconnecting until you press Connect again (or you re-enable auto-connect depending on the plugin).

### Auto Connect (Per Profile)

Auto-connect is saved to the active profile.

That means:

- Profile A can auto-connect to OBS
- Profile B can keep OBS disconnected

Switching profiles can change which integrations connect.

## Understanding "Unavailable" (Greyed Targets)

Targets can become greyed/unavailable when:

- The integration is disconnected (OBS/Wave Link not connected)
- The external app is not running
- The plugin is missing

MIDIMaster preserves the saved name/icon of integration targets even when a plugin is missing. You will still see the same target name you chose previously, but it will be marked unavailable.

## Installing and Removing Plugins

### Installing Plugins (.midimaster)

Plugins are distributed as a single `.midimaster` package file.

To install a plugin:

1. Open MIDIMaster.
2. Click the top-right `Plugins` button.
3. Go to the `Installed` tab.
4. Click `Install Plugin...`.
5. Select a `.midimaster` file.

MIDIMaster installs the plugin into its config directory and loads it at runtime.

### Installing Plugins from the Store

MIDIMaster also includes an in-app Store tab that lists plugins from the official catalog.

To install a plugin from the Store:

1. Open MIDIMaster.
2. Click the top-right `Plugins` button.
3. Go to the `Store` tab.
4. Find the plugin and click `Install` (or `Update`).

Notes:

- The official Store is curated.
- Store installs require an internet connection.
- Store downloads are verified by the app before installation.

### Enable / Disable / Uninstall

In `Plugins -> Installed` you can:

- Enable/disable plugins
- Uninstall third-party plugins

Bundled plugins (for example, OBS Studio and Wave Link) cannot be uninstalled, but can be disabled.

### Where Plugins Are Stored (Advanced)

MIDIMaster stores plugins in its config directory:

`<app_config_dir>/plugins/<plugin_id>/manifest.json`

Typical locations (can vary by packaging):

- Windows: `C:\Users\<you>\AppData\Roaming\MIDIMaster\plugins\`

Each plugin lives in its own folder named after the plugin id.

### Manual Install / Removal (Advanced)

If needed (for development or recovery), you can still manage plugin folders manually:

- Install: place a folder at `plugins/<plugin_id>/` containing `manifest.json` and your entry file.
- Remove: delete the folder `plugins/<plugin_id>/`.

Bindings that used that plugin will still display their stored names/icons, but will be unavailable.

## Troubleshooting

### Targets stay unavailable even after connecting

1. Open `Plugins` and confirm the integration is connected.
2. Wait a moment; some integrations load targets asynchronously.
3. Disconnect then Connect once.
4. Verify you are on the expected Profile (auto-connect is per-profile).

### Integration target list is empty

Most integrations only return target lists when connected.

- Connect the integration in the Plugins modal.
- Try again.

### Motor faders do not move

- Confirm a MIDI Output device is selected.
- Confirm the integration/plugin is connected.
- Ensure the binding is to a target that supports feedback updates.

### I installed a plugin but it does not appear

- Confirm the folder structure is:

  `plugins/<plugin_id>/manifest.json`

- Confirm `manifest.json` has correct `id`, `api_version`, and `entry`.
- Restart MIDIMaster.
