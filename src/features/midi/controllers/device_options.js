import {
  stripUnavailableSuffix,
  unavailableDeviceLabel,
  hasDuplicateInputRoute,
} from "../device_preferences.js";
import {
  positionFloatingDropdownMenu,
  wireDropdownToggle,
  renderLabelWithBadges,
  closeOpenDropdowns,
} from "../../ui/dropdown_badges.js";

/** device options workflow. */
export function createDeviceOptions({
  currentRoutesForSave,
  discovery,
  routeView,
  t,
  updateRouteFromSelect,
}) {
  function findDeviceBySavedIdentity(devices, id, savedName) {
    const list = Array.isArray(devices) ? devices : [];
    const deviceId = String(id || "").trim();
    const deviceName = stripUnavailableSuffix(savedName || "");
    if (deviceId && deviceName) {
      return list.find((device) => device.id === deviceId && device.name === deviceName) || null;
    }
    if (deviceId) {
      return list.find((device) => device.id === deviceId) || null;
    }
    if (deviceName) {
      return list.find((device) => device.name === deviceName) || null;
    }
    return null;
  }

  function deviceOptionLabel(devices, id, fallbackName, kind) {
    const match = findDeviceBySavedIdentity(devices, id, fallbackName);
    if (match) return match.name || id;
    return unavailableDeviceLabel(fallbackName, id, kind);
  }

  function routeWithResolvedNames(route) {
    const inputs = discovery.lastDeviceSnapshot.inputs || [];
    const outputs = discovery.lastDeviceSnapshot.outputs || [];
    return {
      ...route,
      inputDeviceName: deviceOptionLabel(inputs, route.inputDeviceId, route.inputDeviceName, "Input"),
      outputDeviceName: deviceOptionLabel(outputs, route.outputDeviceId, route.outputDeviceName, "Output"),
    };
  }

  function buildRouteSelect(kind, route, index) {
    const wrapper = document.createElement("div");
    wrapper.className = "midi-route-select-wrap";
    const devices =
      kind === "input" ? discovery.lastDeviceSnapshot.inputs : discovery.lastDeviceSnapshot.outputs;
    const selectedId = kind === "input" ? route.inputDeviceId : route.outputDeviceId;
    const selectedName = kind === "input" ? route.inputDeviceName : route.outputDeviceName;
    const placeholderText = kind === "input" ? t("midi.selectInputDevice") : t("midi.selectOutputDevice");
    const currentRoutes = currentRoutesForSave();

    const options = [{ id: "", name: placeholderText, unavailable: false }];
    (Array.isArray(devices) ? devices : []).forEach((device) => {
      const optionName = device.name || device.id;
      let disabled = false;
      if (kind === "input") {
        const candidateRoutes = currentRoutes.slice();
        candidateRoutes[index] = {
          ...route,
          inputDeviceId: device.id,
          inputDeviceName: optionName,
        };
        disabled = hasDuplicateInputRoute(candidateRoutes, device.id, index);
      }
      options.push({
        id: device.id,
        name: optionName,
        unavailable: false,
        disabled,
        disabledReason: disabled ? t("midi.duplicateInputRoute") : "",
      });
    });
    const cleanSelectedName = stripUnavailableSuffix(selectedName || "");
    const selectedAvailableOption = options.find(
      (option) => option.id === selectedId && (!cleanSelectedName || option.name === cleanSelectedName),
    );
    const selectedUnavailable = Boolean(selectedId && !selectedAvailableOption);
    if (selectedUnavailable) {
      options.push({
        id: selectedId,
        name: unavailableDeviceLabel(selectedName, selectedId, kind === "input" ? "Input" : "Output"),
        unavailable: true,
      });
    }

    const selectedOption =
      selectedAvailableOption ||
      (selectedId ? options.find((option) => option.id === selectedId && option.unavailable) : null) ||
      options[0];
    const root = document.createElement("div");
    root.className = "target-dropdown midi-route-dropdown settings-select-dropdown";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "target-button";
    button.title = placeholderText;
    button.disabled = routeView.routeEditorApplyInFlight;
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");

    const display = document.createElement("span");
    display.className = "target-display";
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "\u25be";
    button.appendChild(display);
    button.appendChild(caret);

    const menu = document.createElement("div");
    menu.className = "target-menu hidden";
    menu.setAttribute("role", "listbox");
    root.__positionDropdownMenu = () => {
      if (menu.classList.contains("hidden")) return;
      positionFloatingDropdownMenu({ menu, trigger: button, minHeight: 120, maxHeight: 260 });
    };
    wireDropdownToggle({ root, menu, trigger: button });

    renderLabelWithBadges(display, {
      text: stripUnavailableSuffix(selectedOption.name || placeholderText),
      badges: selectedOption.unavailable ? [{ text: t("targets.unavailable"), kind: "state" }] : [],
      truncate: true,
    });
    root.classList.toggle("target-unavailable", Boolean(selectedOption.unavailable));

    options.forEach((option) => {
      if (!option.id) return;
      const optionButton = document.createElement("button");
      optionButton.type = "button";
      optionButton.className = "target-option";
      optionButton.setAttribute("role", "option");
      const optionMatchesSelection =
        option.id === selectedId &&
        (option.unavailable || !cleanSelectedName || option.name === cleanSelectedName);
      optionButton.setAttribute("aria-selected", String(optionMatchesSelection));
      if (optionMatchesSelection) optionButton.classList.add("selected");
      if (option.unavailable) optionButton.classList.add("unavailable");
      if (routeView.routeEditorApplyInFlight || (option.disabled && !optionMatchesSelection)) {
        optionButton.disabled = true;
        optionButton.classList.add("is-disabled");
        optionButton.setAttribute("aria-disabled", "true");
        if (option.disabledReason) optionButton.title = option.disabledReason;
      }

      const optionLabel = document.createElement("span");
      optionLabel.className = "target-label";
      renderLabelWithBadges(optionLabel, {
        text: stripUnavailableSuffix(option.name || option.id),
        badges: option.unavailable ? [{ text: t("targets.unavailable"), kind: "state" }] : [],
        truncate: false,
      });
      optionButton.appendChild(optionLabel);
      optionButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (option.disabled && !optionMatchesSelection) return;
        closeOpenDropdowns({ except: null });
        await updateRouteFromSelect(index, kind, option.id);
      });
      menu.appendChild(optionButton);
    });

    root.appendChild(button);
    root.appendChild(menu);
    wrapper.appendChild(root);
    return wrapper;
  }

  return { findDeviceBySavedIdentity, routeWithResolvedNames, buildRouteSelect };
}
