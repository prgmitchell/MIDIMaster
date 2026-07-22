import assert from "node:assert/strict";
import * as bindingModel from "../src/core/binding_model.js";
import { createTargetCore } from "../src/core/target_core.js";
const targetCore = createTargetCore({
  masterIconData: null,
  focusIconData: null,
  mediaPlayPauseIconData: null,
  getSessions: () => [],
  getPlaybackDevices: () => [],
  getRecordingDevices: () => [],
  getFocusedSession: () => null,
  getPluginHost: () => null,
  getIntegrationTargetState: () => null,
});

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

function testCustomCurveNormalizationPreservesSegmentBend() {
  const normalized = bindingModel.normalizeCustomCurvePoints([
    { x: 1.2, y: 1.2, curve: 2 },
    { x: 0.5, y: 0.25, curve: -0.35 },
    { x: -0.2, y: -0.2, curve: 0.4 },
  ]);

  assert.deepEqual(normalized, [
    { x: 0, y: 0, curve: 0.4 },
    { x: 0.5, y: 0.25, curve: -0.35 },
    { x: 1, y: 1 },
  ]);
}

function testCustomCurveInterpolationAppliesSegmentBend() {
  assert.equal(
    bindingModel.applyCustomFaderCurve([
      { x: 0, y: 0, curve: 0.5 },
      { x: 1, y: 1 },
    ], 0.5),
    0.75,
  );
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

function testProgramChangeAutoBindingIsButton() {
  const binding = buttonBinding({
    control_kind: "Auto",
    control: { msg_type: "ProgramChange", channel: 0, controller: 124 },
  });

  assert.equal(bindingModel.buttonVisualBehavior(binding), "momentary");
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 1 }), true);
}

function testProgramChangeButtonBindingIsButton() {
  const binding = buttonBinding({
    control_kind: "Button",
    control: { msg_type: "ProgramChange", channel: 0, controller: 0 },
  });

  assert.equal(bindingModel.buttonVisualBehavior(binding), "momentary");
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 1 }), true);
}

function testMomentaryButtonFollowsInputValue() {
  const binding = buttonBinding();

  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 1 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 63 / 127 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 1 / 127 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 0 }), false);
}

function testMappedLightControlsButtonVisualState() {
  const binding = buttonBinding({ button_light_mode: "MappedWhenAssigned" });

  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 0 }), true);
}

function testMappedLightRequiresCompleteTarget() {
  const incomplete = buttonBinding({
    action: "Hotkey",
    target: "Hotkey",
    targets: ["Hotkey"],
    button_light_mode: "MappedWhenAssigned",
  });
  const complete = buttonBinding({
    action: "Hotkey",
    target: "Hotkey",
    targets: ["Hotkey"],
    button_light_mode: "MappedWhenAssigned",
    hotkey: { keys: ["Ctrl", "M"], display: "Ctrl+M" },
  });

  assert.equal(bindingModel.resolveButtonVisualActive(incomplete, { inputValue: 1 }), false);
  assert.equal(bindingModel.resolveButtonVisualActive(complete, { inputValue: 0 }), true);
}

function testMappedLightAcceptsConfiguredSoundboard() {
  const binding = buttonBinding({
    action: "Soundboard",
    target: "Soundboard",
    targets: ["Soundboard"],
    button_light_mode: "MappedWhenAssigned",
    soundboard: { path: "C:\\sounds\\intro.mp3" },
  });

  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 0 }), true);
}

function testProfileSwitchTargetIsCompleteAndMomentary() {
  const binding = buttonBinding({
    action: "SwitchProfile",
    target: { Profile: { name: "Streaming" } },
    targets: [{ Profile: { name: "Streaming" } }],
    button_light_mode: "MappedWhenAssigned",
  });

  assert.equal(bindingModel.buttonVisualBehavior(binding), "momentary");
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 0 }), true);
  assert.deepEqual(targetCore.resolveOsdTarget(binding.target), {
    label: "Profile: Streaming",
    icon_data: null,
  });
  assert.equal(targetCore.resolveTargetKey(binding.target), "profile:Streaming");
  assert.equal(targetCore.resolveTargetVolume(binding.target), null);
}

function testHotkeyMappingUsesPhysicalKeysForShiftedSymbols() {
  assert.deepEqual(
    bindingModel.buildHotkeyMappingFromEvent({
      key: "<",
      code: "Comma",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    }),
    { keys: ["Ctrl", "Shift", "Comma"], display: "Ctrl+Shift+Comma" },
  );
  assert.deepEqual(
    bindingModel.buildHotkeyMappingFromEvent({
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    }),
    { keys: ["Ctrl", "Shift", "Period"], display: "Ctrl+Shift+Period" },
  );
  assert.deepEqual(
    bindingModel.buildHotkeyMappingFromEvent({
      key: "!",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    }),
    { keys: ["Ctrl", "Shift", "1"], display: "Ctrl+Shift+1" },
  );
}

function testHotkeyMappingKeepsLetterShortcuts() {
  assert.deepEqual(
    bindingModel.buildHotkeyMappingFromEvent({
      key: "A",
      code: "KeyA",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    }),
    { keys: ["Ctrl", "Shift", "A"], display: "Ctrl+Shift+A" },
  );
}

function testHotkeyMappingUsesPhysicalNumpadKeys() {
  assert.deepEqual(
    bindingModel.buildHotkeyMappingFromEvent({
      key: "ArrowLeft",
      code: "Numpad4",
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    }),
    { keys: ["Shift", "Numpad4"], display: "Shift+Numpad4" },
  );
  assert.deepEqual(
    bindingModel.buildHotkeyMappingFromEvent({
      key: ".",
      code: "NumpadDecimal",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    }),
    { keys: ["Ctrl", "NumpadDecimal"], display: "Ctrl+NumpadDecimal" },
  );
}

function testNormalizeButtonLightModeKeepsLegacyValuesOnly() {
  assert.equal(bindingModel.normalizeButtonLightMode("MappedWhenAssigned"), "MappedWhenAssigned");
  assert.equal(bindingModel.normalizeButtonLightMode("FollowState"), "Activity");
  assert.equal(bindingModel.normalizeButtonLightMode("InvertState"), "Activity");
  assert.equal(bindingModel.normalizeButtonLightMode("Pressed"), "Activity");
  assert.equal(bindingModel.normalizeButtonLightMode("Activity"), "Activity");
  assert.equal(bindingModel.normalizeButtonLightMode("not-a-mode"), "Activity");
  assert.equal(bindingModel.normalizeButtonLightBehavior("FollowState"), "FollowState");
  assert.equal(bindingModel.normalizeButtonLightBehavior("InvertState"), "InvertState");
  assert.equal(bindingModel.normalizeButtonLightBehavior("Pressed"), "Pressed");
  assert.equal(bindingModel.normalizeButtonLightBehavior("not-a-mode"), "FollowState");
}

function testNormalizeBindingMovesUnsafeLightModesToBehavior() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    button_light_mode: "Pressed",
  }));

  assert.equal(normalized.button_light_mode, "Activity");
  assert.equal(normalized.button_light_behavior, "Pressed");
  assert.equal(bindingModel.effectiveButtonLightMode(normalized), "Pressed");
}

function testNormalizeBindingPreservesDowngradeSafeBehavior() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    button_light_mode: "Activity",
    button_light_behavior: "InvertState",
  }));

  assert.equal(normalized.button_light_mode, "Activity");
  assert.equal(normalized.button_light_behavior, "InvertState");
  assert.equal(bindingModel.effectiveButtonLightMode(normalized), "InvertState");
}

function testNormalizeBindingDropsInterimToggleMuteLightMode() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "ToggleMute",
    toggle_mute_light_mode: "UnmutedLit",
  }));

  assert.equal(Object.hasOwn(normalized, "toggle_mute_light_mode"), false);
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

function testToggleMuteInvertStateLightsWhileUnmuted() {
  const binding = buttonBinding({
    action: "ToggleMute",
    target: { Application: { name: "firefox.exe" } },
    button_light_mode: "Activity",
    button_light_behavior: "InvertState",
  });

  assert.equal(bindingModel.buttonVisualBehavior(binding), "stateful");
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { muted: true }), false);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { muted: false }), true);
}

function testMappedLightOverridesToggleMuteState() {
  const binding = buttonBinding({
    action: "ToggleMute",
    target: { Application: { name: "firefox.exe" } },
    button_light_mode: "MappedWhenAssigned",
  });

  assert.equal(bindingModel.resolveButtonVisualActive(binding, { muted: true }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { muted: false }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { inputValue: 0, muted: false }), true);
}

function testFollowStateUsesStateWithPressFallback() {
  const stateful = buttonBinding({
    action: "Volume",
    button_light_mode: "Activity",
    button_light_behavior: "FollowState",
    target: {
      Integration: {
        integration_id: "obs",
        kind: "action",
        data: { action: "ToggleRecording", action_kind: "stateful" },
      },
    },
  });
  const momentary = buttonBinding({ button_light_mode: "Activity", button_light_behavior: "FollowState" });

  assert.equal(bindingModel.resolveButtonVisualActive(stateful, { stateValue: 1, inputValue: 0 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(stateful, { stateValue: 0, inputValue: 1 }), false);
  assert.equal(bindingModel.resolveButtonVisualActive(momentary, { inputValue: 1 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(momentary, { inputValue: 0 }), false);
}

function testInvertStateUsesInverseStateWithReleaseFallback() {
  const stateful = buttonBinding({
    action: "Volume",
    button_light_mode: "Activity",
    button_light_behavior: "InvertState",
    target: {
      Integration: {
        integration_id: "obs",
        kind: "action",
        data: { action: "ToggleRecording", action_kind: "stateful" },
      },
    },
  });
  const momentary = buttonBinding({ button_light_mode: "Activity", button_light_behavior: "InvertState" });

  assert.equal(bindingModel.resolveButtonVisualActive(stateful, { stateValue: 1, inputValue: 0 }), false);
  assert.equal(bindingModel.resolveButtonVisualActive(stateful, { stateValue: 0, inputValue: 1 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(momentary, { inputValue: 1 }), false);
  assert.equal(bindingModel.resolveButtonVisualActive(momentary, { inputValue: 0 }), true);
}

function testPressedModeIgnoresToggleState() {
  const binding = buttonBinding({
    action: "ToggleMute",
    target: { Application: { name: "firefox.exe" } },
    button_light_mode: "Activity",
    button_light_behavior: "Pressed",
  });

  assert.equal(bindingModel.resolveButtonVisualActive(binding, { muted: true, inputValue: 0 }), false);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { muted: false, inputValue: 1 }), true);
}

function testLegacyActivityMatchesFollowState() {
  const toggle = buttonBinding({
    action: "ToggleMute",
    target: { Application: { name: "firefox.exe" } },
    button_light_mode: "Activity",
  });
  const momentary = buttonBinding({ button_light_mode: "Activity" });

  assert.equal(bindingModel.resolveButtonVisualActive(toggle, { muted: true, inputValue: 0 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(toggle, { muted: false, inputValue: 1 }), false);
  assert.equal(bindingModel.resolveButtonVisualActive(momentary, { inputValue: 1 }), true);
  assert.equal(bindingModel.resolveButtonVisualActive(momentary, { inputValue: 0 }), false);
}

function testStatefulButtonKeepsHalfThreshold() {
  const binding = buttonBinding({
    action: "Volume",
    target: {
      Integration: {
        integration_id: "obs",
        kind: "action",
        data: { action: "ToggleRecording", action_kind: "stateful" },
      },
    },
  });

  assert.equal(bindingModel.buttonVisualBehavior(binding), "stateful");
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { stateValue: 0.49 }), false);
  assert.equal(bindingModel.resolveButtonVisualActive(binding, { stateValue: 0.51 }), true);
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

function testNormalizeMacroStepsClampsAndLimitsShape() {
  const manyWaits = Array.from({ length: 30 }, () => ({
    kind: "wait",
    duration_ms: 999999,
  }));
  const normalized = bindingModel.normalizeMacroSteps(manyWaits);

  assert.equal(normalized.length, bindingModel.MACRO_MAX_TOP_LEVEL_STEPS);
  assert.equal(normalized[0].duration_ms, bindingModel.MACRO_MAX_WAIT_MS);
}

function testNormalizeMacroStepsFiltersInvalidNestedActions() {
  const normalized = bindingModel.normalizeMacroSteps([
    {
      kind: "parallel",
      steps: [
        { action: "Macro", targets: ["Macro"] },
        { action: "ToggleMute", targets: ["Macro"] },
        { action: "ToggleMute", targets: ["Master"], state: "Mute" },
        ...Array.from({ length: 12 }, () => ({ action: "MediaPlayPause", targets: ["MediaControl"] })),
      ],
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].kind, "parallel");
  assert.equal(normalized[0].steps.length, bindingModel.MACRO_MAX_PARALLEL_STEPS);
  assert.equal(normalized[0].steps[0].action, "ToggleMute");
  assert.equal(normalized[0].steps[0].state, "Mute");
}

function testNormalizeMacroStepStateAndValueMapping() {
  const normalized = bindingModel.normalizeMacroSteps([
    {
      kind: "action",
      action: "Volume",
      targets: ["Master"],
      value: 3,
      state: "Wat",
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].value, 1);
  assert.equal(normalized[0].state, "Default");
}

function testNormalizeMacroStepPreservesActionMetadata() {
  const normalized = bindingModel.normalizeMacroSteps([
    {
      kind: "action",
      action: "Volume",
      targets: ["Master"],
      value: 0.42,
      action_role: "value",
      action_label: "Set Value",
      value_kind: "percent",
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].action_role, "value");
  assert.equal(normalized[0].action_label, "Set Value");
  assert.equal(normalized[0].value_kind, "percent");
  assert.equal(normalized[0].value, 0.42);
}

function testIntegrationTargetKeyIgnoresActionSelectionMetadata() {
  const baseHue = {
    integration_id: "hue",
    kind: "light",
    data: { id: "1", label: "Bedroom" },
  };
  const hueTurnOn = {
    integration_id: "hue",
    kind: "light",
    data: {
      id: "1",
      label: "Bedroom",
      action_label: "Turn On",
      action_value: "Volume",
      action_kind: "momentary",
      button_action: "turn_on",
      osd_value_text: "ON",
    },
  };
  const obsStart = {
    integration_id: "obs",
    kind: "action",
    data: { action: "StartRecord", action_kind: "momentary" },
  };
  const obsStop = {
    integration_id: "obs",
    kind: "action",
    data: { action: "StopRecord", action_kind: "momentary" },
  };

  assert.equal(targetCore.integrationTargetKey(baseHue), targetCore.integrationTargetKey(hueTurnOn));
  assert.notEqual(targetCore.integrationTargetKey(obsStart), targetCore.integrationTargetKey(obsStop));
}

function testNormalizeBindingPreservesMacroDraftShape() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "Macro",
    target: "Macro",
    targets: ["Macro"],
    macro_steps: [
      { kind: "action", action: "", targets: [] },
      { kind: "wait", duration_ms: -25 },
      {
        kind: "action",
        action: "Hotkey",
        targets: ["Hotkey"],
        hotkey: { keys: ["Ctrl", "S"], display: "Ctrl+S" },
      },
      {
        kind: "parallel",
        steps: [
          { action: "", targets: [] },
          { action: "", targets: [] },
        ],
      },
    ],
  }));

  assert.equal(normalized.action, "Macro");
  assert.deepEqual(normalized.targets, ["Macro"]);
  assert.equal(normalized.macro_steps.length, 4);
  assert.deepEqual(normalized.macro_steps[0], {
    kind: "action",
    action: "Volume",
    targets: [],
    state: "Default",
  });
  assert.equal(normalized.macro_steps[1].duration_ms, 0);
  assert.deepEqual(normalized.macro_steps[2].hotkey, { keys: ["Ctrl", "S"], display: "Ctrl+S" });
  assert.equal(normalized.macro_steps[3].kind, "parallel");
  assert.equal(normalized.macro_steps[3].steps.length, 2);
  assert.deepEqual(
    bindingModel.normalizeMacroSteps(normalized.macro_steps).map((step) => step.kind),
    ["wait", "action"],
  );
  assert.equal(bindingModel.buttonVisualBehavior(normalized), "momentary");
}

function testNormalizeBindingPreservesMacroName() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "Macro",
    target: "Macro",
    targets: ["Macro"],
    macro_name: "  Game Mix Macro  ",
  }));

  assert.equal(normalized.macro_name, "Game Mix Macro");
}

function testNormalizeBindingDefaultsLegacyMacroName() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "Macro",
    target: "Macro",
    targets: ["Macro"],
  }));

  assert.equal(normalized.macro_name, "");
}

function testNormalizeBindingPreservesNoteIndicatorControl() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    indicator_control: {
      device_id: "midi:0",
      channel: 3.7,
      controller: 24.9,
      msg_type: "Note",
      control_kind: "Button",
    },
  }));

  assert.deepEqual(normalized.indicator_control, {
    device_id: "midi:0",
    channel: 3,
    controller: 24,
    msg_type: "Note",
    control_kind: "Button",
    mode: "Absolute",
    deadzone: 0,
    debounce_ms: 0,
    mute_behavior: "ToggleOnPress",
  });
}

function testNormalizeBindingPreservesFaderFeedbackOutputControl() {
  const normalized = bindingModel.normalizeBinding(relativeBinding({
    control_kind: "Continuous",
    control: { msg_type: "ControlChange", channel: 0, controller: 7 },
    indicator_control: {
      device_id: "midi:1",
      channel: 15.9,
      controller: 127.9,
      msg_type: "ControlChange",
      control_kind: "Continuous",
    },
  }));

  assert.deepEqual(normalized.indicator_control, {
    device_id: "midi:1",
    channel: 15,
    controller: 127,
    msg_type: "ControlChange",
    control_kind: "Continuous",
    mode: "Absolute",
    deadzone: 0,
    debounce_ms: 0,
    mute_behavior: "ToggleOnPress",
  });
}

function testNormalizeBindingPreservesPitchBendFaderFeedbackOutputControl() {
  const normalized = bindingModel.normalizeBinding(relativeBinding({
    control_kind: "Continuous",
    control: { msg_type: "PitchBend", channel: 4, controller: 224 },
    indicator_control: {
      device_id: "midi:2",
      channel: 6.9,
      controller: 224,
      msg_type: "PitchBend",
      control_kind: "Continuous",
    },
  }));

  assert.deepEqual(normalized.indicator_control, {
    device_id: "midi:2",
    channel: 6,
    controller: 0,
    msg_type: "PitchBend",
    control_kind: "Continuous",
    mode: "Absolute",
    deadzone: 0,
    debounce_ms: 0,
    mute_behavior: "ToggleOnPress",
  });
}

function testNormalizeBindingDropsUnsupportedIndicatorControl() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    indicator_control: {
      device_id: "midi:0",
      channel: 0,
      controller: 9,
      msg_type: "ProgramChange",
    },
  }));

  assert.equal(normalized.indicator_control, null);
}

function testNormalizeBindingDropsPitchBendButtonIndicatorControl() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    indicator_control: {
      device_id: "midi:0",
      channel: 0,
      controller: 0,
      msg_type: "PitchBend",
      control_kind: "Button",
    },
  }));

  assert.equal(normalized.indicator_control, null);
}

function testNormalizeSoundboardBindingAndDefaults() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "Soundboard",
    target: "Soundboard",
    targets: ["Soundboard"],
    soundboard: {
      path: "C:\\sounds\\intro.mp3",
      display: "",
      trim_start_ms: -20,
      trim_end_ms: 2500,
      volume: 4,
    },
  }));

  assert.equal(normalized.action, "Soundboard");
  assert.deepEqual(normalized.targets, ["Soundboard"]);
  assert.deepEqual(normalized.soundboard, {
    path: "C:\\sounds\\intro.mp3",
    display: "intro.mp3",
    trim_start_ms: 0,
    trim_end_ms: 2500,
    volume: 1,
    speed: 1,
    output_device_id: null,
    output_device_display: null,
  });
  assert.equal(bindingModel.buttonVisualBehavior(normalized), "momentary");
}

function testSoundboardMappingRejectsBlankPathAndClampsEnd() {
  assert.equal(bindingModel.normalizeSoundboardMapping({ path: "" }), null);
  assert.deepEqual(bindingModel.normalizeSoundboardMapping({
    path: "clip.wav",
    trim_start_ms: 500,
    trim_end_ms: 100,
  }), {
    path: "clip.wav",
    display: "clip.wav",
    trim_start_ms: 500,
    trim_end_ms: 501,
    volume: 1,
    speed: 1,
    output_device_id: null,
    output_device_display: null,
  });
}

function testSoundboardIsUniqueAndNormalizesPlaybackOptions() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "Soundboard",
    targets: ["Soundboard", "Master", "Soundboard"],
    soundboard: {
      path: "clip.wav",
      speed: 4,
      output_device_id: " device-1 ",
      output_device_display: " Speakers ",
    },
  }));
  assert.deepEqual(normalized.targets, ["Soundboard", "Master"]);
  assert.equal(normalized.soundboard.speed, 2);
  assert.equal(normalized.soundboard.output_device_id, "device-1");
  assert.equal(normalized.soundboard.output_device_display, "Speakers");
}

function testSoundboardCoexistsWithPrimaryMediaAction() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "MediaPlayPause",
    targets: ["Soundboard", "MediaControl"],
    soundboard: { path: "clip.wav" },
  }));
  assert.equal(normalized.action, "MediaPlayPause");
  assert.deepEqual(normalized.targets, ["Soundboard", "MediaControl"]);
  assert.equal(normalized.soundboard.path, "clip.wav");
}

function testMacroAndSoundboardConflictKeepsOneSpecialTarget() {
  const normalized = bindingModel.normalizeBinding(buttonBinding({
    action: "MediaPlayPause",
    targets: ["Macro", "Soundboard", "MediaControl"],
    macro_name: "My Macro",
    macro_steps: [],
    soundboard: { path: "clip.wav" },
  }));
  assert.equal(normalized.action, "MediaPlayPause");
  assert.deepEqual(normalized.targets, ["Macro", "MediaControl"]);
  assert.equal(normalized.soundboard, null);

  const soundboardPreferred = bindingModel.normalizeBinding(buttonBinding({
    action: "Soundboard",
    targets: ["Macro", "Soundboard"],
    macro_name: "Discard me",
    soundboard: { path: "clip.wav" },
  }));
  assert.deepEqual(soundboardPreferred.targets, ["Soundboard"]);
  assert.equal(soundboardPreferred.macro_name, "");
  assert.equal(soundboardPreferred.soundboard.path, "clip.wav");
}

function testNormalizeAssignModeSupportsClearAndDefaultsUnknownValues() {
  for (const mode of ["Add", "Replace", "Clear"]) {
    const normalized = bindingModel.normalizeBinding(buttonBinding({ assign_mode: mode }));
    assert.equal(normalized.assign_mode, mode);
  }

  const unknown = bindingModel.normalizeBinding(buttonBinding({ assign_mode: "Unknown" }));
  assert.equal(unknown.assign_mode, "Add");
}

testNormalizeBindingPreservesExplicitRelativeFormat();
testCustomCurveNormalizationPreservesSegmentBend();
testCustomCurveInterpolationAppliesSegmentBend();
testExplicitRelativeFormatsDecodeWithoutAutoState();
testAutoDetectionMatchesBackendMidpointRule();
testAutoDetectionUsesSignMagnitudeWithoutMidpoint();
testAutoDetectionUsesTwosComplementForHighNegativeBand();
testWaveLinkSetMainOutputIsMomentary();
testProgramChangeAutoBindingIsButton();
testProgramChangeButtonBindingIsButton();
testMomentaryButtonFollowsInputValue();
testMappedLightControlsButtonVisualState();
testMappedLightRequiresCompleteTarget();
testMappedLightAcceptsConfiguredSoundboard();
testProfileSwitchTargetIsCompleteAndMomentary();
testHotkeyMappingUsesPhysicalKeysForShiftedSymbols();
testHotkeyMappingKeepsLetterShortcuts();
testHotkeyMappingUsesPhysicalNumpadKeys();
testNormalizeButtonLightModeKeepsLegacyValuesOnly();
testNormalizeBindingMovesUnsafeLightModesToBehavior();
testNormalizeBindingPreservesDowngradeSafeBehavior();
testNormalizeBindingDropsInterimToggleMuteLightMode();
testToggleMuteFollowsMutedState();
testToggleMuteInvertStateLightsWhileUnmuted();
testMappedLightOverridesToggleMuteState();
testFollowStateUsesStateWithPressFallback();
testInvertStateUsesInverseStateWithReleaseFallback();
testPressedModeIgnoresToggleState();
testLegacyActivityMatchesFollowState();
testStatefulButtonKeepsHalfThreshold();
testUnsetToggleMuteButtonIsMomentary();
testIntegrationVisualBehaviorKinds();
testNormalizeBindingPreservesAutoHotkeyScriptMapping();
testNormalizeMacroStepsClampsAndLimitsShape();
testNormalizeMacroStepsFiltersInvalidNestedActions();
testNormalizeMacroStepStateAndValueMapping();
testNormalizeMacroStepPreservesActionMetadata();
testIntegrationTargetKeyIgnoresActionSelectionMetadata();
testNormalizeBindingPreservesMacroDraftShape();
testNormalizeBindingPreservesMacroName();
testNormalizeBindingDefaultsLegacyMacroName();
testNormalizeBindingPreservesNoteIndicatorControl();
testNormalizeBindingPreservesFaderFeedbackOutputControl();
testNormalizeBindingPreservesPitchBendFaderFeedbackOutputControl();
testNormalizeBindingDropsUnsupportedIndicatorControl();
testNormalizeBindingDropsPitchBendButtonIndicatorControl();
testNormalizeSoundboardBindingAndDefaults();
testSoundboardMappingRejectsBlankPathAndClampsEnd();
testSoundboardIsUniqueAndNormalizesPlaybackOptions();
testSoundboardCoexistsWithPrimaryMediaAction();
testMacroAndSoundboardConflictKeepsOneSpecialTarget();
testNormalizeAssignModeSupportsClearAndDefaultsUnknownValues();

console.log("Binding model tests passed");
