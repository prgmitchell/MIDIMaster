import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/core/binding_model.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const bindingModel = await import(moduleUrl);

function relativeBinding(overrides = {}) {
  return {
    id: "relative-test",
    mode: "Relative",
    relative_format: "Auto",
    fader_curve: "Linear",
    custom_curve: [],
    mute_behavior: "ToggleOnPress",
    button_light_mode: "Activity",
    target: "Master",
    ...overrides,
  };
}

function buttonBinding(overrides = {}) {
  return {
    id: "button-test",
    action: "SetMainOutputDevice",
    control_kind: "Button",
    control: { msg_type: "Note", channel: 0, controller: 1 },
    target: {
      Integration: {
        integration_id: "wavelink",
        kind: "action",
        data: { action_kind: "momentary" },
      },
    },
    button_light_mode: "Activity",
    ...overrides,
  };
}

function testNormalizeBindingPreservesExplicitRelativeFormat() {
  const normalized = bindingModel.normalizeBinding(
    relativeBinding({ relative_format: "BinaryOffset" }),
  );

  assert.equal(normalized.relative_format, "BinaryOffset");
}

function testExplicitRelativeFormatsDecodeWithoutAutoState() {
  const autoState = new Map();
  assert.equal(
    bindingModel.decodeRelativeDelta(
      relativeBinding({ relative_format: "SignMagnitude" }),
      65,
      autoState,
    ),
    -1,
  );
  assert.equal(autoState.size, 0);
}

function testAutoDetectionMatchesBackendMidpointRule() {
  const autoState = new Map();
  const binding = relativeBinding();

  assert.equal(bindingModel.decodeRelativeDelta(binding, 64, autoState), 0);
  assert.equal(bindingModel.decodeRelativeDelta(binding, 65, autoState), 1);
  assert.equal(autoState.get(binding.id).format, "BinaryOffset");
}

function testAutoDetectionUsesSignMagnitudeWithoutMidpoint() {
  const autoState = new Map();
  const binding = relativeBinding({ id: "sign-magnitude-test" });

  assert.equal(bindingModel.decodeRelativeDelta(binding, 65, autoState), -1);
  assert.equal(autoState.get(binding.id).format, "SignMagnitude");
}

function testAutoDetectionUsesTwosComplementForHighNegativeBand() {
  const autoState = new Map();
  const binding = relativeBinding({ id: "twos-test" });

  assert.equal(bindingModel.decodeRelativeDelta(binding, 127, autoState), -1);
  assert.equal(autoState.get(binding.id).format, "TwosComplement");
}

function testWaveLinkSetMainOutputIsMomentary() {
  assert.equal(bindingModel.buttonVisualBehavior(buttonBinding()), "momentary");
}

function testMomentaryButtonFollowsInputValue() {
  const binding = buttonBinding();

  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 1 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 0 }), false);
}

function testMappedLightDoesNotControlButtonVisualState() {
  const binding = buttonBinding({ button_light_mode: "MappedWhenAssigned" });

  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 0 }), false);
}

function testToggleMuteFollowsMutedState() {
  const binding = buttonBinding({
    action: "ToggleMute",
    target: { Application: { name: "firefox.exe" } },
  });

  assert.equal(bindingModel.buttonVisualBehavior(binding), "stateful");
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { muted: true }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { muted: false }), false);
}

function testUnsetToggleMuteButtonIsMomentary() {
  const binding = buttonBinding({
    action: "ToggleMute",
    target: "Unset",
    targets: ["Unset"],
  });

  assert.equal(bindingModel.buttonVisualBehavior(binding), "momentary");
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 1 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 0, muted: true }), false);
}

function testIntegrationVisualBehaviorKinds() {
  const stateful = buttonBinding({
    action: "Volume",
    target: {
      Integration: {
        integration_id: "obs",
        kind: "action",
        data: { action: "ToggleMute", action_kind: "stateful" },
      },
    },
  });
  const obsToggle = buttonBinding({
    action: "Volume",
    target: {
      Integration: {
        integration_id: "obs",
        kind: "action",
        data: { action: "ToggleRecording" },
      },
    },
  });
  const momentary = buttonBinding({
    action: "Volume",
    target: {
      Integration: {
        integration_id: "obs",
        kind: "media",
        data: { action_kind: "momentary" },
      },
    },
  });

  assert.equal(bindingModel.buttonVisualBehavior(stateful), "stateful");
  assert.equal(bindingModel.resolveButtonVisualActive(stateful, { stateValue: 1, inputValue: 0 }), true);
  assert.equal(bindingModel.buttonVisualBehavior(obsToggle), "stateful");
  assert.equal(bindingModel.buttonVisualBehavior(momentary), "momentary");
  assert.equal(bindingModel.resolveButtonVisualActive(momentary, { inputValue: 1 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(momentary, { inputValue: 0, stateValue: 1 }), false);
}

function testNormalizeBindingPreservesAutoHotkeyScriptMapping() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "RunAutoHotkeyScript",
    target: "AutoHotkeyScript",
    autohotkey_script: {
      path: " C:\\Users\\Test\\Scripts\\mute-toggle.ahk ",
      display: " mute-toggle.ahk ",
    },
  }));

  assert.deepEqual(normalized.targets, ["AutoHotkeyScript"]);
  assert.deepEqual(normalized.autohotkey_script, {
    path: "C:\\Users\\Test\\Scripts\\mute-toggle.ahk",
    display: "mute-toggle.ahk",
  });
  assert.equal(bindingModel.buttonVisualBehavior(normalized), "momentary");
}

testNormalizeBindingPreservesExplicitRelativeFormat();
testExplicitRelativeFormatsDecodeWithoutAutoState();
testAutoDetectionMatchesBackendMidpointRule();
testAutoDetectionUsesSignMagnitudeWithoutMidpoint();
testAutoDetectionUsesTwosComplementForHighNegativeBand();
testWaveLinkSetMainOutputIsMomentary();
testMomentaryButtonFollowsInputValue();
testMappedLightDoesNotControlButtonVisualState();
testToggleMuteFollowsMutedState();
testUnsetToggleMuteButtonIsMomentary();
testIntegrationVisualBehaviorKinds();
testNormalizeBindingPreservesAutoHotkeyScriptMapping();

console.log("Binding model tests passed");
