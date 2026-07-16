# MIDIMaster User Guide

This guide explains how to set up MIDIMaster, create bindings, use Profiles, and manage integrations (plugins).

If you are a plugin author, see `docs/PLUGIN_DEVELOPER_GUIDE.md`.

## What MIDIMaster Does

MIDIMaster binds controls on your MIDI device (faders, knobs, buttons) to targets such as:

- `Master` volume
- `Focus` (the currently focused application/session)
- Per-application audio sessions
- Playback / recording devices
- Utility actions such as hotkeys, application launch, and AutoHotkey scripts
- Integrations provided by plugins (OBS Studio, Wave Link, Voicemeeter, Philips Hue, and third-party integrations)

When a target changes, MIDIMaster can send feedback back to your MIDI controller (for motorized faders, LEDs, etc.).

## First-Time Setup

### 1) Configure MIDI Routes

1. Open MIDIMaster.
2. The topbar shows the currently active MIDI input and output. If multiple routes are active, the first route is shown with a `+N` badge.
3. Open `MIDI Routes` from the route button beside the Output readout.
4. Add one or more routes. Each route pairs:
   - MIDI Input (the device you move)
   - MIDI Output (the device MIDIMaster sends feedback to)
5. Select `Apply Changes` to validate and activate the complete route set. Closing the popover or selecting `Cancel` discards uncommitted edits.

Notes:

- Every active MIDI input route requires an output device.
- Motorized faders and LEDs receive feedback through the output paired with the binding's input route.
- Duplicate input routes are prevented. Sharing one output is allowed and marked with a `Shared` badge.
- If a saved route is temporarily unavailable, other routes remain active and MIDIMaster retries the missing route automatically.
- Disable a route to disconnect that MIDI session while keeping it saved. `Disconnect All` disables all routes and stops MIDI until you re-enable a route.

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
- `Hotkey`
- `Open Application`
- `AutoHotkey Script` (runs a selected `.ahk` file through Windows' configured AutoHotkey association)
- `Soundboard` (plays a linked audio file when the button is pressed)
- `Switch Profile` (loads a selected saved profile, including its bindings, MIDI routes, plugin settings, and OSD settings)

Integrations may interpret actions differently depending on the plugin.

### Soundboard Buttons

Choose `Soundboard` from the target picker's Actions category, then select an MP3, WAV, FLAC, OGG/Vorbis, M4A, MP4, or AAC file. A button can contain either one Soundboard or one Macro alongside its normal targets, but never both. Adding a duplicate special target or trying to combine Macro and Soundboard shows an alert without changing the binding. The compact Configure Soundboard editor has play/pause preview controls, a moving waveform playhead and time ruler, draggable start and end handles, playback speed and volume controls, and an output-device selector. The keyboard-accessible trim sliders move by 10 ms with the arrow keys or 100 ms with Shift+arrow.

Soundboard files stay linked at their original absolute paths; profile export does not copy the audio. If a file is moved or unavailable, MIDIMaster preserves the link. Use `Edit Sound` and then `Pick Sound` to choose it again. The selected output is saved with the sound; `System default` keeps following the operating system's default playback device. Audio files must be no larger than 100 MB and no longer than 10 minutes. Pressing the same Soundboard button restarts its sound, while different Soundboard buttons can overlap, including when they use different outputs. Playback continues while MIDIMaster is minimized to the tray.

## Targets

### Built-in Targets

- `Master`: system master volume
- `Focus`: the currently focused session
- `Applications`: discovered audio sessions
- `Playback Devices` / `Recording Devices`
- `Utilities`: media controls, macros, Soundboard, hotkeys, window focus, capture controls, application launch, AutoHotkey scripts, and profile switching

If an application or device disappears, MIDIMaster will show an unavailable entry (greyed).

### Integration Targets (Plugins)

Integrations show up in the target picker under an `Integrations` section.

Examples:

- OBS Studio audio input volume
- Wave Link channel or mix volume
- Voicemeeter strip/bus levels, routing, hardware devices, MacroButtons, and presets
- Philips Hue light/group brightness and on/off

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

Bundled plugins (for example, OBS Studio, Wave Link, Voicemeeter, and Philips Hue) cannot be uninstalled, but can be disabled.

### Voicemeeter (Bundled) Quick Setup

The Voicemeeter integration supports Voicemeeter Standard, Banana, and Potato on Windows. It uses the Remote API DLL installed by Voicemeeter; no separate helper or network service is required.

1. Start Voicemeeter.
2. Open `Plugins` and select `Voicemeeter`.
3. Click `Connect`, or enable `Auto connect` so MIDIMaster attaches when Voicemeeter is running.
4. Create a binding and choose `Integrations -> Voicemeeter`.
5. Pick a strip, bus, routing button, hardware device, MacroButton, preset, or safe engine action.

Notes:

- Auto connect never launches Voicemeeter. The dashboard's `Launch` button is always an explicit action.
- Faders and knobs receive live parameter feedback; stateful MIDI buttons can follow mute, solo, routing, and MacroButton state.
- The dashboard shows live strip and bus meters only while its tab is open. Meter data is not sent as MIDI feedback.
- Hardware device changes can interrupt audio. `Restart engine` asks for confirmation.
- MacroButton aliases use lines such as `1: Stream mute`. Preset targets use lines such as `1: Streaming`; these labels are saved per MIDIMaster profile.
- System settings, VBAN, patch matrices, recorder controls, shutdown, reset, and arbitrary Voicemeeter scripts are intentionally not exposed.

### Philips Hue (Bundled) Quick Setup

1. Open `Plugins` and select `Philips Hue`.
2. Click `Discover` (or manually enter your bridge IP).
3. Press the physical button on your Hue Bridge.
4. Click `Pair`.
5. Click `Connect`.

Once connected, Hue lights and groups appear in the Integrations target picker.
Faders control Hue brightness. Button bindings let you choose a light or group, then choose `Toggle On/Off`, `Turn On`, or `Turn Off`.

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

- Open `MIDI Routes` and confirm the binding's input device route is enabled.
- Confirm that route has the correct MIDI Output device selected.
- Confirm the integration/plugin is connected.
- Ensure the binding is to a target that supports feedback updates.

### I installed a plugin but it does not appear

- Confirm the folder structure is:

  `plugins/<plugin_id>/manifest.json`

- Confirm `manifest.json` has correct `id`, `api_version`, and `entry`.
- Restart MIDIMaster.
