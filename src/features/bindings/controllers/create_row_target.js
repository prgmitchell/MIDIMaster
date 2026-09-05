import {
  getBindingTargets as getTargets,
  normalizeHotkeyMapping,
  normalizeOpenApplicationMapping,
  normalizeAutoHotkeyScriptMapping,
  normalizeSoundboardMapping,
  setBindingTargets as setTargets,
  normalizeMacroSteps,
  getPrimaryBindingTarget as getPrimaryTarget,
} from "../../../core/binding_model.js";
import {
  isMacroTarget,
  isSoundboardTarget,
  isHotkeyTarget,
  isOpenApplicationTarget,
  isAutoHotkeyScriptTarget,
} from "../shape_helpers.js";
import { ensureMacroName } from "../macro_draft.js";
import { resolveTargetChangeVolumeValue } from "../value_sync.js";

/** create row target workflow. */
export function createRowTargetController({
  bindingLastValues,
  bindingMuteValues,
  buildTarget,
  finishBindingUiMutation,
  getMuted,
  getVol,
  invoke,
  openConfigModal,
  renderBindings,
  renderedBindings,
  setMuteButtonState,
  setSliderVolume,
  showMacroAlreadyConfiguredError,
  showSoundboardAlreadyConfiguredError,
  showSpecialActionConflictError,
  startHotkeyLearn,
}) {
  function createRowTarget(binding, isButton, readControls) {
    const targetSelect = buildTarget(
      getTargets(binding),
      isButton,
      binding.action,
      binding.hotkey?.display || "",
      binding.open_application,
      binding.autohotkey_script,
      {
        macroDisplayName: binding.macro_name,
        macroAlreadyConfigured:
          isButton && (binding.action === "Macro" || getTargets(binding).some(isMacroTarget)),
        onMacroAlreadyConfigured: showMacroAlreadyConfiguredError,
        soundboardAlreadyConfigured:
          isButton && (binding.action === "Soundboard" || getTargets(binding).some(isSoundboardTarget)),
        onSoundboardAlreadyConfigured: showSoundboardAlreadyConfiguredError,
        macroBlockedBySoundboard: isButton && getTargets(binding).some(isSoundboardTarget),
        soundboardBlockedByMacro: isButton && getTargets(binding).some(isMacroTarget),
        onSpecialActionConflict: showSpecialActionConflictError,
      },
    );
    targetSelect.addEventListener("change", async () => {
      const { volumeSlider, muteButton } = readControls();
      const previousTargets = getTargets(binding);
      const previousHadHotkeyTarget = previousTargets.some(isHotkeyTarget);
      const previousHadOpenApplicationTarget = previousTargets.some(isOpenApplicationTarget);
      const previousHadAutoHotkeyScriptTarget = previousTargets.some(isAutoHotkeyScriptTarget);
      const previousHadMacroTarget = previousTargets.some(isMacroTarget);
      const previousHadSoundboardTarget = previousTargets.some(isSoundboardTarget);
      const selectedTargets = Array.isArray(targetSelect.__selectedTargets)
        ? targetSelect.__selectedTargets
        : targetSelect.__selectedTarget
          ? [targetSelect.__selectedTarget]
          : [];
      const hasSelectedTarget = selectedTargets.some((target) => target && target !== "Unset");
      const hasHotkeyTarget = selectedTargets.some(isHotkeyTarget);
      const hasOpenApplicationTarget = selectedTargets.some(isOpenApplicationTarget);
      const hasAutoHotkeyScriptTarget = selectedTargets.some(isAutoHotkeyScriptTarget);
      const hasMacroTarget = selectedTargets.some(isMacroTarget);
      const hasSoundboardTarget = selectedTargets.some(isSoundboardTarget);
      const hasRegularTarget = selectedTargets.some(
        (target) => !isMacroTarget(target) && !isSoundboardTarget(target),
      );
      const previousAction = binding.action;
      const previousHotkey = normalizeHotkeyMapping(binding.hotkey);
      const previousOpenApplication = normalizeOpenApplicationMapping(binding.open_application);
      const previousAutoHotkeyScript = normalizeAutoHotkeyScriptMapping(binding.autohotkey_script);
      const previousSoundboard = normalizeSoundboardMapping(binding.soundboard);

      if (isButton && hasMacroTarget && hasSoundboardTarget) {
        showSpecialActionConflictError();
        renderBindings();
        finishBindingUiMutation("special action conflict");
        return;
      }

      setTargets(binding, selectedTargets);

      if (isButton) {
        if (!hasSelectedTarget) {
          binding.action = "ToggleMute";
        } else if (hasRegularTarget) {
          const requestedAction = targetSelect.dataset.action || binding.action || "ToggleMute";
          binding.action =
            requestedAction === "Macro" || requestedAction === "Soundboard"
              ? previousAction === "Macro" || previousAction === "Soundboard"
                ? "ToggleMute"
                : previousAction
              : requestedAction;
        } else if (hasMacroTarget) {
          binding.action = "Macro";
        } else if (hasSoundboardTarget) {
          binding.action = "Soundboard";
        } else {
          binding.action = targetSelect.dataset.action || binding.action || "ToggleMute";
        }
      } else {
        binding.action = "Volume";
      }

      if (isButton && hasMacroTarget) {
        binding.macro_steps = previousHadMacroTarget ? normalizeMacroSteps(binding.macro_steps) : [];
        ensureMacroName(binding, { defaultIfBlank: !previousHadMacroTarget });
      }

      if (isButton && hasSoundboardTarget) {
        binding.soundboard = previousSoundboard;
      } else if (previousHadSoundboardTarget || previousAction === "Soundboard") {
        binding.soundboard = null;
      }

      if (isButton && previousHadMacroTarget && !hasMacroTarget) {
        binding.macro_steps = [];
        binding.macro_name = "";
      }

      if (isButton && !hasHotkeyTarget && previousHadHotkeyTarget) {
        binding.hotkey = null;
        targetSelect?.setHotkeyDisplay?.("");
        if (binding.action === "Hotkey") {
          binding.action = targetSelect.dataset.action || "ToggleMute";
        }
      }

      if (isButton && !hasOpenApplicationTarget && previousHadOpenApplicationTarget) {
        binding.open_application = null;
        if (binding.action === "OpenApplication") {
          binding.action = targetSelect.dataset.action || "ToggleMute";
        }
      }

      if (isButton && !hasAutoHotkeyScriptTarget && previousHadAutoHotkeyScriptTarget) {
        binding.autohotkey_script = null;
        if (binding.action === "RunAutoHotkeyScript") {
          binding.action = targetSelect.dataset.action || "ToggleMute";
        }
      }

      if (isButton && hasHotkeyTarget && !previousHadHotkeyTarget) {
        const learnedHotkey = await startHotkeyLearn(binding);
        if (!learnedHotkey) {
          setTargets(binding, previousTargets);
          binding.action = previousAction || "ToggleMute";
          binding.hotkey = previousHotkey;
          binding.open_application = previousOpenApplication;
          binding.autohotkey_script = previousAutoHotkeyScript;
          binding.soundboard = previousSoundboard;
          await invoke("add_binding", { binding });
          renderBindings();
          finishBindingUiMutation("target rollback");
          return;
        }
        binding.hotkey = learnedHotkey;
        targetSelect?.setHotkeyDisplay?.(binding.hotkey?.display || "");
      }

      if (isButton && binding.action === "OpenApplication") {
        binding.open_application = normalizeOpenApplicationMapping(
          targetSelect?.getOpenApplication?.() || targetSelect?.__openApplication,
        );
      } else {
        binding.open_application = null;
      }

      if (isButton && binding.action === "RunAutoHotkeyScript") {
        binding.autohotkey_script = normalizeAutoHotkeyScriptMapping(
          targetSelect?.getAutoHotkeyScript?.() || targetSelect?.__autoHotkeyScript,
        );
      } else {
        binding.autohotkey_script = null;
      }

      if (
        isButton &&
        !hasHotkeyTarget &&
        !hasOpenApplicationTarget &&
        !hasAutoHotkeyScriptTarget &&
        binding.action === "OpenApplication" &&
        !binding.open_application
      ) {
        setTargets(binding, previousTargets);
        binding.action = previousAction || "ToggleMute";
        binding.hotkey = previousHotkey;
        binding.open_application = previousOpenApplication;
        binding.autohotkey_script = previousAutoHotkeyScript;
        await invoke("add_binding", { binding });
        renderBindings();
        finishBindingUiMutation("target rollback");
        return;
      }

      if (
        isButton &&
        !hasHotkeyTarget &&
        !hasOpenApplicationTarget &&
        !hasAutoHotkeyScriptTarget &&
        binding.action === "RunAutoHotkeyScript" &&
        !binding.autohotkey_script
      ) {
        setTargets(binding, previousTargets);
        binding.action = previousAction || "ToggleMute";
        binding.hotkey = previousHotkey;
        binding.open_application = previousOpenApplication;
        binding.autohotkey_script = previousAutoHotkeyScript;
        await invoke("add_binding", { binding });
        renderBindings();
        finishBindingUiMutation("target rollback");
        return;
      }

      if (!isButton) {
        const primaryTarget = getPrimaryTarget(binding);
        const newVolume = resolveTargetChangeVolumeValue({
          targetVolume: getVol(primaryTarget),
          cachedVolume: bindingLastValues[binding.id],
        });
        if (volumeSlider) {
          // Keep current slider position if the new primary target cannot report
          // a concrete volume (common for some integration targets).
          // This prevents motorized faders from jumping when removing targets.
          if (typeof newVolume === "number" && Number.isFinite(newVolume)) {
            setSliderVolume(volumeSlider, newVolume, { bindingId: binding.id });
          }
          volumeSlider.dataset.targetJson = JSON.stringify(primaryTarget);
        }

        const newMuted =
          bindingMuteValues[binding.id] != null
            ? Boolean(bindingMuteValues[binding.id])
            : getMuted(primaryTarget);
        if (muteButton) {
          setMuteButtonState(muteButton, newMuted);
          muteButton.dataset.targetJson = JSON.stringify(primaryTarget);
        }
        renderedBindings.register(binding.id, { target: primaryTarget });
      }

      const initialPersistence = invoke("add_binding", { binding });
      if (isButton && hasMacroTarget && !previousHadMacroTarget) {
        openConfigModal(binding.id, {
          macroPage: true,
          initialPersistence,
        });
      } else if (isButton && hasSoundboardTarget && !previousHadSoundboardTarget) {
        openConfigModal(binding.id, {
          soundboardPage: true,
          removeEmptySoundboardTargetOnCancel: true,
          initialPersistence,
        });
      }
      await initialPersistence;
      renderBindings();
      finishBindingUiMutation("target change");
    });

    return targetSelect;
  }

  return { createRowTarget };
}
