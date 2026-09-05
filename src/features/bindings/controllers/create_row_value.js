import { getBindingTargets as getTargets } from "../../../core/binding_model.js";
import { isMacroTarget, isSoundboardTarget } from "../shape_helpers.js";

/** create row value workflow. */
export function createRowValueController({
  bindingInteractionTimes,
  bindingLastValues,
  buttonUsesPressReleaseCommand,
  buttonVisualActive,
  invoke,
  openConfigModal,
  pulseMomentaryValue,
  t,
}) {
  function createRowValue(binding, isButton, visualBehavior, volumeSlider, muteButton, isMuted) {
    const valueGroup = document.createElement("div");
    valueGroup.className = "binding-value-cell";
    if (isButton) {
      valueGroup.classList.add("binding-value-cell--button");
      const pulse = document.createElement("button");
      pulse.type = "button";
      pulse.className = "binding-momentary-value";
      const isStatefulButton = visualBehavior === "stateful";
      const isMomentaryPress = visualBehavior === "momentary";
      const usesPressReleaseCommand = buttonUsesPressReleaseCommand(binding);
      pulse.classList.add(
        "binding-button-value",
        isStatefulButton ? "binding-button-value--stateful" : "binding-button-value--momentary",
      );
      pulse.classList.toggle("is-active", buttonVisualActive(binding, { fallbackMuted: isMuted }));
      pulse.dataset.bindingId = binding.id;
      pulse.title = isStatefulButton ? t("bindings.toggleBinding") : t("bindings.triggerBinding");
      pulse.setAttribute("aria-label", pulse.title);

      const invokeButtonValue = async (value) => {
        await invoke("apply_binding_action", {
          bindingId: binding.id,
          action: binding.action || "Volume",
          value,
          silent: false,
          source: "ui_button",
        });
      };

      const releaseMomentary = async () => {
        if (!pulse.__buttonPressed) return;
        pulse.__buttonPressed = false;
        pulse.classList.remove("is-active");
        if (!usesPressReleaseCommand) return;
        try {
          await invokeButtonValue(0.0);
        } catch (err) {
          console.error("Failed to release binding:", err);
        }
      };

      if (isStatefulButton) {
        pulse.addEventListener("click", async () => {
          bindingInteractionTimes[binding.id] = Date.now();
          if (binding.action === "ToggleMute") {
            muteButton.click();
            return;
          }
          const currentlyOn = pulse.classList.contains("is-active");
          pulse.classList.toggle("is-active", !currentlyOn);
          bindingLastValues[binding.id] = currentlyOn ? 0.0 : 1.0;
          try {
            await invokeButtonValue(1.0);
          } catch (err) {
            pulse.classList.toggle("is-active", currentlyOn);
            bindingLastValues[binding.id] = currentlyOn ? 1.0 : 0.0;
            console.error("Failed to trigger toggle action:", err);
          }
        });
      } else if (usesPressReleaseCommand) {
        pulse.addEventListener("pointerdown", async (event) => {
          event.preventDefault();
          if (pulse.__buttonPressed) return;
          pulse.__buttonPressed = true;
          bindingInteractionTimes[binding.id] = Date.now();
          pulse.classList.add("is-active");
          try {
            pulse.setPointerCapture?.(event.pointerId);
          } catch {}
          try {
            await invokeButtonValue(1.0);
          } catch (err) {
            pulse.__buttonPressed = false;
            pulse.classList.remove("is-active");
            console.error("Failed to trigger binding:", err);
          }
        });
        pulse.addEventListener("pointerup", releaseMomentary);
        pulse.addEventListener("pointercancel", releaseMomentary);
        pulse.addEventListener("lostpointercapture", releaseMomentary);
      } else if (isMomentaryPress) {
        pulse.addEventListener("click", async () => {
          bindingInteractionTimes[binding.id] = Date.now();
          pulseMomentaryValue(pulse);
          try {
            await invokeButtonValue(1.0);
          } catch (err) {
            console.error("Failed to trigger binding:", err);
          }
        });
      }
      pulse.addEventListener("keydown", async (event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        if (!usesPressReleaseCommand || pulse.__buttonPressed) return;
        event.preventDefault();
        bindingInteractionTimes[binding.id] = Date.now();
        pulse.__buttonPressed = true;
        pulse.classList.add("is-active");
        try {
          await invokeButtonValue(1.0);
        } catch (err) {
          pulse.__buttonPressed = false;
          pulse.classList.remove("is-active");
          console.error("Failed to trigger binding:", err);
        }
      });
      pulse.addEventListener("keyup", async (event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        if (!usesPressReleaseCommand) return;
        event.preventDefault();
        await releaseMomentary();
      });
      valueGroup.appendChild(pulse);
      if (getTargets(binding).some(isMacroTarget)) {
        valueGroup.classList.add("binding-value-cell--macro");
        const editMacroButton = document.createElement("button");
        editMacroButton.type = "button";
        editMacroButton.className = "binding-macro-edit-button";
        editMacroButton.textContent = t("macro.edit");
        editMacroButton.title = t("macro.edit");
        editMacroButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openConfigModal(binding.id, { macroPage: true });
        });
        valueGroup.appendChild(editMacroButton);
      }
      if (getTargets(binding).some(isSoundboardTarget)) {
        valueGroup.classList.add("binding-value-cell--soundboard");
        const editSoundButton = document.createElement("button");
        editSoundButton.type = "button";
        editSoundButton.className = "binding-macro-edit-button binding-soundboard-edit-button";
        editSoundButton.textContent = t("soundboard.edit");
        editSoundButton.title = t("soundboard.edit");
        editSoundButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openConfigModal(binding.id, { soundboardPage: true });
        });
        valueGroup.appendChild(editSoundButton);
      }
      if (binding.action === "ToggleMute") {
        valueGroup.appendChild(muteButton);
      }
    } else {
      const sliderWrap = document.createElement("div");
      sliderWrap.className = "binding-slider-wrap";

      const percent = document.createElement("span");
      percent.className = "binding-volume-percent";
      const updatePercent = () => {
        percent.textContent = `${Math.round((Number(volumeSlider.value) || 0) * 100)}%`;
      };
      updatePercent();
      volumeSlider.addEventListener("input", updatePercent);
      sliderWrap.appendChild(volumeSlider);
      valueGroup.appendChild(sliderWrap);
      valueGroup.appendChild(percent);
      valueGroup.appendChild(muteButton);
    }

    return valueGroup;
  }

  return { createRowValue };
}
