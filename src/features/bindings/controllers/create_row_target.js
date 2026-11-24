import {
  getBindingTargets as getTargets,
  normalizeOpenApplicationMapping,
  normalizeAutoHotkeyScriptMapping,
  setBindingTargets as setTargets,
  normalizeMacroSteps,
  getPrimaryBindingTarget as getPrimaryTarget,
} from "../../../core/binding_model.js";
import {
  cloneBindingDraft,
  isMacroTarget,
  isSoundboardTarget,
  isHotkeyTarget,
  isOpenApplicationTarget,
  isAutoHotkeyScriptTarget,
} from "../shape_helpers.js";
import { ensureMacroName } from "../macro_draft.js";
import { resolveTargetChangeVolumeValue } from "../value_sync.js";

function selectedAction(binding, selected, requestedAction) {
  if (!selected.some((target) => target && target !== "Unset")) return "ToggleMute";
  if (selected.every(isMacroTarget)) return "Macro";
  if (selected.every(isSoundboardTarget)) return "Soundboard";
  const regularAction = (action) => action && action !== "Macro" && action !== "Soundboard";
  if (regularAction(requestedAction)) return requestedAction;
  return regularAction(binding.action) ? binding.action : "ToggleMute";
}

async function draftTargetChange(binding, isButton, picker, startHotkeyLearn, showConflict) {
  const previous = getTargets(binding);
  const selected = Array.isArray(picker.__selectedTargets)
    ? picker.__selectedTargets
    : picker.__selectedTarget
      ? [picker.__selectedTarget]
      : [];
  const macro = selected.some(isMacroTarget);
  const sound = selected.some(isSoundboardTarget);
  if (isButton && macro && sound) {
    showConflict();
    return null;
  }

  const draft = cloneBindingDraft(binding);
  setTargets(draft, selected);
  draft.action = isButton ? selectedAction(binding, selected, picker.dataset.action) : "Volume";
  if (isButton && macro) {
    draft.macro_steps = previous.some(isMacroTarget) ? normalizeMacroSteps(draft.macro_steps) : [];
    ensureMacroName(draft, { defaultIfBlank: !previous.some(isMacroTarget) });
  } else if (isButton && previous.some(isMacroTarget)) {
    draft.macro_steps = [];
    draft.macro_name = "";
  }
  if (!sound && (previous.some(isSoundboardTarget) || binding.action === "Soundboard"))
    draft.soundboard = null;
  const hotkey = selected.some(isHotkeyTarget);
  if (isButton && hotkey && !previous.some(isHotkeyTarget)) {
    draft.hotkey = await startHotkeyLearn(draft);
    if (!draft.hotkey) return null;
  } else if (isButton && !hotkey && previous.some(isHotkeyTarget)) {
    draft.hotkey = null;
    if (draft.action === "Hotkey") draft.action = picker.dataset.action || "ToggleMute";
  }
  if (
    isButton &&
    !selected.some(isOpenApplicationTarget) &&
    previous.some(isOpenApplicationTarget) &&
    draft.action === "OpenApplication"
  )
    draft.action = picker.dataset.action || "ToggleMute";
  if (
    isButton &&
    !selected.some(isAutoHotkeyScriptTarget) &&
    previous.some(isAutoHotkeyScriptTarget) &&
    draft.action === "RunAutoHotkeyScript"
  )
    draft.action = picker.dataset.action || "ToggleMute";
  draft.open_application =
    draft.action === "OpenApplication"
      ? normalizeOpenApplicationMapping(picker.getOpenApplication?.() || picker.__openApplication)
      : null;
  draft.autohotkey_script =
    draft.action === "RunAutoHotkeyScript"
      ? normalizeAutoHotkeyScriptMapping(
          picker.getAutoHotkeyScript?.() || picker.__autoHotkeyScript,
        )
      : null;
  const utilityTarget =
    hotkey || selected.some(isOpenApplicationTarget) || selected.some(isAutoHotkeyScriptTarget);
  if (
    !utilityTarget &&
    ((draft.action === "OpenApplication" && !draft.open_application) ||
      (draft.action === "RunAutoHotkeyScript" && !draft.autohotkey_script))
  )
    return null;
  return draft;
}

export function createRowTargetController({
  bindingLastValues,
  bindingMuteValues,
  buildTarget,
  bindingEdits,
  getMuted,
  getVol,
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
    const targets = getTargets(binding);
    const targetSelect = buildTarget(
      targets,
      isButton,
      binding.action,
      binding.hotkey?.display || "",
      binding.open_application,
      binding.autohotkey_script,
      {
        macroDisplayName: binding.macro_name,
        macroAlreadyConfigured:
          isButton && (binding.action === "Macro" || targets.some(isMacroTarget)),
        onMacroAlreadyConfigured: showMacroAlreadyConfiguredError,
        soundboardAlreadyConfigured:
          isButton && (binding.action === "Soundboard" || targets.some(isSoundboardTarget)),
        onSoundboardAlreadyConfigured: showSoundboardAlreadyConfiguredError,
        macroBlockedBySoundboard: isButton && targets.some(isSoundboardTarget),
        soundboardBlockedByMacro: isButton && targets.some(isMacroTarget),
        onSpecialActionConflict: showSpecialActionConflictError,
      },
    );
    targetSelect.addEventListener("change", async () => {
      targetSelect.inert = true;
      targetSelect.setAttribute("aria-busy", "true");
      try {
        const { volumeSlider, muteButton } = readControls();
        const draft = await draftTargetChange(
          binding,
          isButton,
          targetSelect,
          startHotkeyLearn,
          showSpecialActionConflictError,
        );
        if (!draft) {
          renderBindings({ forceBindingId: binding.id });
          return;
        }
        const added = (predicate) =>
          isButton && getTargets(draft).some(predicate) && !getTargets(binding).some(predicate);
        const openMacro = added(isMacroTarget);
        const openSoundboard = added(isSoundboardTarget);
        if (openSoundboard && !draft.soundboard) {
          openConfigModal(binding.id, { soundboardPage: true, targetDraft: draft });
          renderBindings({ forceBindingId: binding.id });
          return;
        }
        await bindingEdits.save(binding, draft);
        if (!isButton) {
          const primaryTarget = getPrimaryTarget(draft);
          const newVolume = resolveTargetChangeVolumeValue({
            targetVolume: getVol(primaryTarget),
            cachedVolume: bindingLastValues[binding.id],
          });
          if (volumeSlider) {
            // Keep current slider position if the new primary target cannot report
            // a concrete volume (common for some integration targets).
            // This prevents motorized faders from jumping when removing targets.
            if (typeof newVolume === "number" && Number.isFinite(newVolume)) {
              setSliderVolume(volumeSlider, newVolume, {
                bindingId: binding.id,
              });
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

        renderBindings({ forceBindingId: binding.id });
        if (openMacro) openConfigModal(binding.id, { macroPage: true });
        if (openSoundboard) openConfigModal(binding.id, { soundboardPage: true });
      } catch (error) {
        renderBindings({ forceBindingId: binding.id });
        console.error("Failed to change binding targets:", error);
      } finally {
        targetSelect.inert = false;
        targetSelect.removeAttribute("aria-busy");
      }
    });

    return targetSelect;
  }

  return { createRowTarget };
}
