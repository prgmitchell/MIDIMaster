import { modeTooltip, effectiveIsButton, buttonModeValue } from "../shape_helpers.js";
import {
  renderLabelWithBadges,
  positionFloatingDropdownMenu,
  wireDropdownToggle,
} from "../../ui/dropdown_badges.js";
import { normalizeRelativeFormat } from "../../../core/binding_model.js";

/** create row mode workflow. */
export function createRowModeController({ finishBindingUiMutation, invoke, renderBindings, t }) {
  function createRowMode(binding) {
    const modeDropdown = document.createElement("div");
    modeDropdown.className = "target-dropdown mode-dropdown";
    const modeButton = document.createElement("button");
    modeButton.type = "button";
    modeButton.className = "target-button";
    modeButton.title = t("bindings.controlMode");
    modeButton.setAttribute("aria-haspopup", "listbox");
    modeButton.setAttribute("aria-expanded", "false");
    const modeDisplay = document.createElement("span");
    modeDisplay.className = "target-display";
    const modeCaret = document.createElement("span");
    modeCaret.className = "caret";
    modeCaret.textContent = "\u25be";
    modeButton.appendChild(modeDisplay);
    modeButton.appendChild(modeCaret);
    const modeMenu = document.createElement("div");
    modeMenu.className = "target-menu hidden";

    const modeOptions = [
      { value: "fader_abs", label: t("bindings.absolute"), badge: t("bindings.fader"), title: "" },
      { value: "fader_rel", label: t("bindings.relative"), badge: t("bindings.fader"), title: "" },
      {
        value: "button_toggle",
        label: t("bindings.toggle"),
        badge: t("bindings.button"),
        title: modeTooltip("button_toggle"),
      },
      {
        value: "button_match",
        label: t("common.match"),
        badge: t("bindings.button"),
        title: modeTooltip("button_match"),
      },
    ];

    let modeValue = "fader_abs";
    if (effectiveIsButton(binding)) {
      modeValue = buttonModeValue(binding);
    } else if (binding.mode === "Relative") {
      modeValue = "fader_rel";
    }

    const renderModeLabel = (container, option) => {
      renderLabelWithBadges(container, {
        text: option?.label || "",
        badges: option?.badge ? [{ text: option.badge, kind: "neutral" }] : [],
        truncate: false,
      });
    };

    const applyModeSelection = async (nextModeValue) => {
      if (nextModeValue === "button_toggle" || nextModeValue === "button_match") {
        const keepButtonAction = effectiveIsButton(binding) && binding.action !== "ToggleMute";
        binding.control_kind = "Button";
        if (!keepButtonAction) {
          binding.action = "ToggleMute";
        }
        binding.mute_behavior = nextModeValue === "button_match" ? "SetFromValue" : "ToggleOnPress";
        if (binding.mute_control && typeof binding.mute_control === "object") {
          binding.mute_control.mute_behavior = binding.mute_behavior;
        }
      } else if (nextModeValue === "fader_rel") {
        binding.control_kind = "Continuous";
        binding.mode = "Relative";
        binding.relative_format = normalizeRelativeFormat(binding.relative_format);
        binding.action = "Volume";
      } else {
        binding.control_kind = "Continuous";
        binding.mode = "Absolute";
        binding.relative_format = normalizeRelativeFormat(binding.relative_format);
        binding.action = "Volume";
      }

      await invoke("add_binding", { binding });
      renderBindings();
      finishBindingUiMutation("mode change");
    };

    modeOptions.forEach((option) => {
      const optionButton = document.createElement("button");
      optionButton.type = "button";
      optionButton.className = "target-option";
      if (option.value === modeValue) {
        optionButton.classList.add("selected");
      }
      const optionLabel = document.createElement("span");
      optionLabel.className = "target-label";
      renderModeLabel(optionLabel, option);
      if (option.title) {
        optionButton.title = option.title;
        optionButton.setAttribute("aria-label", option.title);
      }
      optionButton.appendChild(optionLabel);
      optionButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        modeDropdown.classList.remove("open");
        modeMenu.classList.add("hidden");
        modeButton.setAttribute("aria-expanded", "false");
        await applyModeSelection(option.value);
      });
      modeMenu.appendChild(optionButton);
    });

    const activeModeOption = modeOptions.find((option) => option.value === modeValue) || modeOptions[0];
    renderModeLabel(modeDisplay, activeModeOption);
    if (activeModeOption.title) {
      modeButton.title = activeModeOption.title;
      modeButton.setAttribute("aria-label", activeModeOption.title);
    }

    modeDropdown.__positionDropdownMenu = () => {
      positionFloatingDropdownMenu({
        menu: modeMenu,
        trigger: modeButton,
        minHeight: 132,
        maxHeight: 240,
      });
    };

    wireDropdownToggle({ root: modeDropdown, menu: modeMenu, trigger: modeButton });

    modeDropdown.appendChild(modeButton);
    modeDropdown.appendChild(modeMenu);

    return modeDropdown;
  }

  return { createRowMode };
}
