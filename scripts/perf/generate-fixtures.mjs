#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parsePositiveIntegers, runMain, splitCsv } from "./lib/cli.mjs";
import { writeJson } from "./lib/files.mjs";

export const BUNDLED_PLUGIN_IDS = ["hue", "obs", "voicemeeter", "wavelink"];
export const SHAPE_TARGET_BYTES = Object.freeze({
  light: null,
  "0.6mb": 600 * 1024,
  "5mb": 5 * 1024 * 1024,
});

const SVG_PREFIX = "data:image/svg+xml;base64,";

function normalizeShape(shape) {
  if (Object.hasOwn(SHAPE_TARGET_BYTES, shape)) return shape;
  const numeric = Number(shape);
  if (Number.isFinite(numeric)) {
    for (const [name, bytes] of Object.entries(SHAPE_TARGET_BYTES)) {
      if (bytes !== null && Math.abs(numeric - bytes) < 1) return name;
    }
  }
  return shape;
}

function makeBinding(index, iconData = null) {
  const controller = index % 128;
  const isAction = controller % 8 === 0;
  const isButton = isAction || controller % 8 === 4;
  const data = {
    identifier: `channel-${index}`,
    label: `Synthetic channel ${index}`,
    action_kind: isButton ? "stateful" : "continuous",
  };
  if (iconData) data.icon_data = iconData;
  return {
    id: `perf-binding-${index}`,
    name: `Performance binding ${index}`,
    macro_name: "",
    device_id: "perf-midi-input",
    control: {
      channel: index % 16,
      controller,
      msg_type: isAction ? "ProgramChange" : (isButton ? "Note" : "ControlChange"),
    },
    control_kind: isButton ? "Button" : "Continuous",
    targets: [{
      Integration: {
        integration_id: "perf-plugin",
        kind: "channel",
        data,
      },
    }],
    action: isButton ? "ToggleEffect" : "Volume",
    mode: "Absolute",
    deadzone: 0,
    debounce_ms: isButton ? 25 : 0,
  };
}

function makeProfile(name, bindingCount, iconData = null) {
  return {
    name,
    bindings: Array.from({ length: bindingCount }, (_, index) => makeBinding(index, iconData)),
    osd_settings: {
      enabled: false,
      monitor_index: 0,
      anchor: "top-right",
      style: "midnight",
      opacity: 0.96,
      scale: 1,
    },
    plugin_settings: {},
    midi_device_preference: {},
    midi_device_preference_set: false,
  };
}

function serializeProfiles(profiles) {
  return `${JSON.stringify(profiles, null, 2)}\n`;
}

function applyIconToAllBindings(profiles, iconData) {
  for (const profile of profiles) {
    for (const binding of profile.bindings) {
      binding.targets[0].Integration.data.icon_data = iconData;
    }
  }
}

export function createProfilesFixture({ bindingCount, profileCount, shape }) {
  if (!Object.hasOwn(SHAPE_TARGET_BYTES, shape)) throw new Error(`Unknown fixture shape '${shape}'`);
  const profiles = Array.from({ length: profileCount }, (_, index) =>
    makeProfile(index === 0 ? "Performance Default" : `Performance ${index + 1}`, bindingCount));
  const targetBytes = SHAPE_TARGET_BYTES[shape];

  if (targetBytes && bindingCount > 0 && profileCount > 0) {
    const iconSlots = bindingCount * profileCount;
    const withoutIcons = Buffer.byteLength(serializeProfiles(profiles));
    const propertyOverhead = Buffer.byteLength(',\n              "icon_data": ""') * iconSlots;
    const available = Math.max(0, targetBytes - withoutIcons - propertyOverhead);
    const iconChars = Math.max(SVG_PREFIX.length, Math.floor(available / iconSlots));
    applyIconToAllBindings(profiles, `${SVG_PREFIX}${"A".repeat(iconChars - SVG_PREFIX.length)}`);

    // JSON adds one byte for each literal character in these ASCII-only fixtures.
    // Put the remainder in one icon to make the aggregate fixture deterministic.
    const firstData = profiles[0].bindings[0].targets[0].Integration.data;
    const difference = targetBytes - Buffer.byteLength(serializeProfiles(profiles));
    if (difference > 0) firstData.icon_data += "A".repeat(difference);
    else if (difference < 0) firstData.icon_data = firstData.icon_data.slice(0, difference);
  }

  const text = serializeProfiles(profiles);
  return {
    profiles,
    text,
    bytes: Buffer.byteLength(text),
    targetBytes,
    iconCount: bindingCount * profileCount,
  };
}

function disabledPlugins(mode) {
  if (mode === "all") return [];
  if (mode === "one") return BUNDLED_PLUGIN_IDS.filter((id) => id !== "voicemeeter");
  if (mode === "zero") return [...BUNDLED_PLUGIN_IDS];
  throw new Error(`Unknown plugin mode '${mode}'`);
}

export async function generateFixtureMatrix({ output, bindingCounts, profileCounts, shapes, pluginModes, clean = false }) {
  const outputRoot = resolve(output);
  if (clean) await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const fixtures = [];

  for (const bindingCount of bindingCounts) {
    for (const profileCount of profileCounts) {
      for (const shape of shapes) {
        for (const pluginMode of pluginModes) {
          const id = `b${bindingCount}-p${profileCount}-${shape}-plugins-${pluginMode}`;
          const fixtureRoot = join(outputRoot, id);
          const appData = join(fixtureRoot, "app-data", "MIDIMaster");
          const webviewData = join(fixtureRoot, "webview2-data");
          await mkdir(appData, { recursive: true });
          await mkdir(webviewData, { recursive: true });
          const generated = createProfilesFixture({ bindingCount, profileCount, shape });
          await import("node:fs/promises").then(({ writeFile }) => writeFile(join(appData, "profiles.json"), generated.text));
          await writeJson(join(appData, "app_settings.json"), {
            active_profile_name: "Performance Default",
            auto_check_updates: false,
            midi_device_inventory_consent: "disabled",
            midi_device_inventory_notice_version: 1,
          });
          await writeJson(join(appData, "plugins_state.json"), { disabled: disabledPlugins(pluginMode) });
          const manifest = {
            schema_version: "1.0.0",
            fixture_id: id,
            binding_count: bindingCount,
            profile_count: profileCount,
            shape,
            plugin_mode: pluginMode,
            profiles_bytes: generated.bytes,
            target_profiles_bytes: generated.targetBytes,
            icon_count: generated.iconCount,
            app_data_relative: "app-data/MIDIMaster",
            webview_data_relative: "webview2-data",
            synthetic_only: true,
          };
          await writeJson(join(fixtureRoot, "fixture.json"), manifest);
          fixtures.push(manifest);
        }
      }
    }
  }
  await writeJson(join(outputRoot, "manifest.json"), { schema_version: "1.0.0", fixtures });
  return fixtures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["clean", "help"] });
  if (args.help) {
    console.log("Usage: node scripts/perf/generate-fixtures.mjs [--output DIR] [--bindings 0,50,250,500] [--profiles 1,10] [--shapes light,0.6mb,5mb] [--plugins zero,one,all] [--clean]");
    return;
  }
  const defaultOutput = join(tmpdir(), "MIDIMaster-perf-fixtures");
  const output = resolve(args.output ?? defaultOutput);
  const fixtures = await generateFixtureMatrix({
    output,
    bindingCounts: parsePositiveIntegers(args.bindings, [0, 50, 250, 500]),
    profileCounts: parsePositiveIntegers(args.profiles, [1, 10]),
    shapes: splitCsv(args.shapes, ["light", "0.6mb", "5mb"]).map(normalizeShape),
    pluginModes: splitCsv(args.plugins, ["zero", "one", "all"]),
    clean: Boolean(args.clean),
  });
  console.log(`Generated ${fixtures.length} fixtures under ${output}`);
}

runMain(import.meta.url, main);
