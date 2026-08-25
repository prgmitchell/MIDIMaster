import {
  closeOpenDropdowns,
  positionFloatingDropdownMenu,
  renderLabelWithBadges,
  wireDropdownToggle,
} from "../ui/dropdown_badges.js";
import {
  buildPersistedMidiRoutes,
  createMidiRouteDraftController,
  findConnectedAliveDevice,
  findPreferredDevice,
  hasDuplicateInputRoute,
  normalizeMidiPreference,
  normalizeMidiRoute,
  normalizeMidiRoutes,
  orderMidiRoutesByPreference,
  resolvePreferredMidiDevicePair,
  sharedOutputCounts,
  stripUnavailableSuffix,
  unavailableDeviceLabel,
} from "./device_preferences.js";
import {
  createMidiRoutePolicy,
  preserveUnavailableRouteDrafts as mergeUnavailableRouteDrafts,
  routesFromResolvedPreferences,
} from "./route_policy.js";
import { createSessionRefreshScheduler } from "./session_refresh_scheduler.js";

function routeDeviceLabel(route, kind) {
  if (!route) return "";
  if (kind === "input") {
    return route.inputDeviceName || route.inputDeviceId || "";
  }
  return route.outputDeviceName || route.outputDeviceId || "";
}

export function resolveMidiDeviceStatusPresentation({
  routes,
  kind,
  loading = false,
  translate = (key) => key,
} = {}) {
  const activeRoutes = (Array.isArray(routes) ? routes : [])
    .filter((route) => route?.enabled !== false);
  const first = activeRoutes[0] || null;
  const isLoading = Boolean(loading && !first);
  const label = isLoading
    ? translate("midi.loadingDevices")
    : (first ? routeDeviceLabel(first, kind) : translate("midi.noActiveDevice"));
  const additionalDevices = activeRoutes
    .slice(1)
    .map((route) => routeDeviceLabel(route, kind))
    .filter(Boolean);
  return {
    activeRoutes,
    isLoading,
    label,
    additionalDevices,
    title: isLoading
      ? translate("midi.loadingDevices")
      : (activeRoutes.length > 0
        ? activeRoutes.map((route) => routeDeviceLabel(route, kind)).filter(Boolean).join(", ")
        : translate("midi.noActiveDevice")),
  };
}

export function createMidiFeature({
  invoke,
  dom,
  showMain,
  refreshSessions,
  onConnected,
  onDisconnected,
  addBindingFromLearn,
  getSavedMidiDeviceIds,
  clearSavedMidiDeviceIds,
  onProfileDeviceSelected,
  onDeviceInventoryChanged,
  i18n,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createMidiFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};
  const t = (key, params = {}) => (i18n && typeof i18n.t === "function") ? i18n.t(key, params) : String(key || "");
  const MIDI_ENUM_MIN_INTERVAL_MS = 5000;
  const MIDI_ENUM_STALE_MS = 3000;
  const MIDI_AVAILABILITY_DISCONNECTED_INTERVAL_MS = 3000;
  const MIDI_AVAILABILITY_CONNECTED_INTERVAL_MS = 10000;
  const MIDI_AUTO_REFRESH_INTERVAL_MS = 3000;
  const MIDI_OUTPUT_ENUM_DELAY_MS = 250;
  const LEARN_POLL_MS = 50;

  let autoRefreshTimer = null;
  let learnTimer = null;
  let availabilityTimer = null;
  let uiBound = false;
  let availabilityCheckInFlight = false;
  let deviceRefreshInFlight = null;
  let lastDeviceRefreshAt = 0;
  let lastDeviceSnapshot = { inputs: [], outputs: [] };
  let lastDeviceInventorySignature = "";
  let suspendProfileAutoReconnect = false;
  let applyInFlight = false;
  let queuedApply = null;
  let connectedInputId = "";
  let connectedOutputId = "";
  let connectedInputName = "";
  let connectedOutputName = "";
  let connectedRoutes = [];
  const routeEditor = createMidiRouteDraftController();
  let routeEditorApplyInFlight = false;
  let currentProfilePreference = null;
  const routePolicy = createMidiRoutePolicy();
  const sessionRefreshScheduler = createSessionRefreshScheduler();
  let inputStatusEl = null;
  let inputStatusDisplayEl = null;
  let outputStatusEl = null;
  let outputStatusDisplayEl = null;
  let outputRouteShellEl = null;
  let routesButtonEl = null;
  let routesPopoverEl = null;
  let deviceDocClickBound = false;
  let initialDeviceLoadPending = true;

  function setConnectedState(inputId, outputId, inputName = "", outputName = "") {
    setConnectedRoutes(inputId && outputId ? [{
      inputDeviceId: inputId,
      outputDeviceId: outputId,
      inputDeviceName: inputName,
      outputDeviceName: outputName,
      enabled: true,
    }] : []);
  }

  function setConnectedRoutes(routes) {
    connectedRoutes = normalizeMidiRoutes({ routes }).filter((route) => route.enabled !== false);
    const first = connectedRoutes[0] || {};
    connectedInputId = String(first.inputDeviceId || "");
    connectedOutputId = String(first.outputDeviceId || "");
    connectedInputName = String(first.inputDeviceName || "");
    connectedOutputName = String(first.outputDeviceName || "");
  }

  function getDesiredMidiPreference() {
    return normalizeMidiPreference(currentProfilePreference);
  }

  function currentRoutesForSave() {
    const profileRoutes = normalizeMidiPreference(currentProfilePreference).routes;
    return routeEditor.current(profileRoutes.length ? profileRoutes : connectedRoutes);
  }

  function desiredRoutes() {
    return normalizeMidiPreference(currentProfilePreference).routes;
  }

  function preserveUnavailableRouteDrafts(aliveRoutes, missingRoutes) {
    return mergeUnavailableRouteDrafts(
      aliveRoutes,
      missingRoutes,
      currentProfilePreference,
      connectedRoutes,
    );
  }

  function resolveDesiredRouteSet(snapshot, preference, context = "unknown") {
    return routePolicy.resolveDesiredRouteSet(snapshot, preference, context);
  }

  function unresolvedRouteStatus(resolved, fallbackKey = "midi.partialRetrying") {
    return routePolicy.unresolvedRouteStatus(resolved, t, fallbackKey);
  }

  function markSelectedPairUnavailable(inputId, outputId, inputName, outputName) {
    const nextInputId = String(inputId || "").trim();
    const nextOutputId = String(outputId || "").trim();
    if (nextInputId && d.midiSelect) {
      ensureOption(
        d.midiSelect,
        nextInputId,
        unavailableDeviceLabel(inputName, nextInputId, "Input"),
        true,
      );
      d.midiSelect.value = nextInputId;
    }
    if (nextOutputId && d.midiOutputSelect) {
      ensureOption(
        d.midiOutputSelect,
        nextOutputId,
        unavailableDeviceLabel(outputName, nextOutputId, "Output"),
        true,
      );
      d.midiOutputSelect.value = nextOutputId;
    }
    renderDeviceDropdowns();
  }

  function ensureOption(selectEl, value, label, unavailable = false) {
    if (!selectEl || !value) return;
    const existing = Array.from(selectEl.options || []).find((opt) => opt.value === value);
    if (existing) {
      if (label) existing.textContent = label;
      if (unavailable) existing.dataset.unavailable = "true";
      return;
    }
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label || value;
    if (unavailable) option.dataset.unavailable = "true";
    selectEl.appendChild(option);
  }

  function clearUnavailableOptions(selectEl, keepValue = "") {
    if (!selectEl) return;
    const keep = String(keepValue || "").trim();
    Array.from(selectEl.options || []).forEach((opt) => {
      if (opt.dataset?.unavailable === "true" && String(opt.value || "") !== keep) {
        opt.remove();
      }
    });
  }

  function clearUnavailableDeviceSelections() {
    const keepInput = d.midiSelect ? d.midiSelect.value : "";
    const keepOutput = d.midiOutputSelect ? d.midiOutputSelect.value : "";
    clearUnavailableOptions(d.midiSelect, keepInput);
    clearUnavailableOptions(d.midiOutputSelect, keepOutput);
  }

  function routesForUnavailableOptions() {
    const routes = [];
    const seen = new Set();
    [
      normalizeMidiPreference(currentProfilePreference).routes,
      normalizeMidiRoutes({ routes: routeEditor.draft() || [] }),
      normalizeMidiRoutes({ routes: connectedRoutes }),
    ].forEach((list) => {
      list.forEach((route) => {
        const key = `${route.inputDeviceId}\u0000${route.outputDeviceId}`;
        if (seen.has(key)) return;
        seen.add(key);
        routes.push(route);
      });
    });
    return routes;
  }

  function ensureUnavailableRouteOptions(inputDevices, outputDevices) {
    routesForUnavailableOptions().forEach((route) => {
      if (route.inputDeviceId && !findDeviceBySavedIdentity(inputDevices, route.inputDeviceId, route.inputDeviceName)) {
        ensureOption(
          d.midiSelect,
          route.inputDeviceId,
          unavailableDeviceLabel(route.inputDeviceName, route.inputDeviceId, "Input"),
          true,
        );
      }
      if (route.outputDeviceId && !findDeviceBySavedIdentity(outputDevices, route.outputDeviceId, route.outputDeviceName)) {
        ensureOption(
          d.midiOutputSelect,
          route.outputDeviceId,
          unavailableDeviceLabel(route.outputDeviceName, route.outputDeviceId, "Output"),
          true,
        );
      }
    });
  }

  function closeDeviceDropdowns() {
    closeOpenDropdowns({ except: null });
    closeRoutesPopover();
  }

  function discardRouteDrafts() {
    routeEditor.discard();
  }

  function closeRoutesPopover({ discard = true } = {}) {
    if (discard) discardRouteDrafts();
    if (routesPopoverEl) routesPopoverEl.classList.add("hidden");
    if (routesButtonEl) routesButtonEl.setAttribute("aria-expanded", "false");
    renderDeviceDropdowns();
  }

  async function toggleRoutesPopover() {
    ensureRoutesPopover();
    const opening = routesPopoverEl?.classList?.contains("hidden");
    if (!opening) {
      closeRoutesPopover();
      return;
    }
    const cachedResolution = resolveDesiredRouteSet(
      lastDeviceSnapshot,
      { routes: desiredRoutes(), configured: true },
      "route_editor_open_cached",
    );
    routeEditor.begin(routesFromResolvedPreferences(cachedResolution));
    if (routesPopoverEl) routesPopoverEl.classList.remove("hidden");
    if (routesButtonEl) routesButtonEl.setAttribute("aria-expanded", "true");
    renderRoutesPopover();

    void refreshMidiDevices({ force: true, reason: "route_editor_open" }).then((snapshot) => {
      if (routesPopoverEl?.classList?.contains("hidden") || routeEditor.isDirty()) return;
      const refreshedResolution = resolveDesiredRouteSet(
        snapshot,
        { routes: desiredRoutes(), configured: true },
        "route_editor_open_refreshed",
      );
      routeEditor.begin(routesFromResolvedPreferences(refreshedResolution));
      renderRoutesPopover();
    });
  }

  function ensureRoutesPopover() {
    if (!routesButtonEl && d.midiOutputSelect) {
      routesButtonEl = document.createElement("button");
      routesButtonEl.type = "button";
      routesButtonEl.className = "midi-routes-button";
      routesButtonEl.title = t("midi.routes");
      routesButtonEl.setAttribute("aria-label", t("midi.routes"));
      routesButtonEl.setAttribute("aria-haspopup", "dialog");
      routesButtonEl.setAttribute("aria-expanded", "false");
      routesButtonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleRoutesPopover().catch(() => { });
      });
    }
    ensureOutputRouteShell();

    if (!routesPopoverEl) {
      routesPopoverEl = document.createElement("div");
      routesPopoverEl.className = "midi-routes-popover hidden";
      routesPopoverEl.setAttribute("role", "dialog");
      routesPopoverEl.setAttribute("aria-label", t("midi.routes"));
      routesPopoverEl.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      document.body.appendChild(routesPopoverEl);
    }
    syncRoutesPopoverPosition();
  }

  function ensureOutputRouteShell() {
    const outputRoot = outputStatusEl || d.midiOutputSelect;
    if (!outputRoot || !routesButtonEl) return;

    const existingShell = outputRoot.closest?.(".midi-output-route-shell");
    outputRouteShellEl = existingShell || outputRouteShellEl;
    if (!outputRouteShellEl || !outputRouteShellEl.isConnected) {
      outputRouteShellEl = document.createElement("div");
      outputRouteShellEl.className = "midi-output-route-shell";
      outputRoot.parentNode?.insertBefore(outputRouteShellEl, outputRoot);
      outputRouteShellEl.appendChild(outputRoot);
    }

    if (routesButtonEl.parentElement !== outputRouteShellEl) {
      outputRouteShellEl.appendChild(routesButtonEl);
    }
  }

  function syncRoutesButtonLabel() {
    if (!routesButtonEl) return;
    const count = currentRoutesForSave().filter((route) => route.enabled !== false).length;
    routesButtonEl.replaceChildren(createRouteIcon("sliders"));
    routesButtonEl.dataset.routeCount = count > 1 ? String(count) : "";
    routesButtonEl.classList.toggle("has-multiple-routes", count > 1);
    routesButtonEl.title = t("midi.routesCount", { count });
    routesButtonEl.setAttribute("aria-label", t("midi.routesCount", { count }));
  }

  function createRouteIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    const icons = {
      sliders: ["M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M2 14h4", "M10 8h4", "M18 16h4"],
      close: ["M18 6 6 18", "M6 6l12 12"],
      trash: ["M3 6h18", "M8 6V4h8v2", "M6 6l1 15h10l1-15", "M10 11v6", "M14 11v6"],
    };

    (icons[name] || icons.sliders).forEach((dValue) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", dValue);
      svg.appendChild(path);
    });

    return svg;
  }

  function setIconButton(button, name) {
    button.replaceChildren(createRouteIcon(name));
  }

  function syncRoutesPopoverPosition() {
    if (!routesPopoverEl || !routesButtonEl) return;
    const rect = routesButtonEl.getBoundingClientRect();
    const viewportPadding = 16;
    const popoverWidth = Math.min(520, Math.max(0, window.innerWidth - (viewportPadding * 2)));
    const maxLeft = Math.max(viewportPadding, window.innerWidth - popoverWidth - viewportPadding);
    const left = Math.max(viewportPadding, Math.min(rect.left, maxLeft));
    routesPopoverEl.style.top = `${Math.round(rect.bottom + 8)}px`;
    routesPopoverEl.style.left = `${Math.round(left)}px`;
  }

  function ensureDeviceDropdowns() {
    if (!d.midiSelect && !d.midiOutputSelect) return;
    const attachStatus = (selectEl, kind) => {
      if (!selectEl) return;

      let existingRoot = kind === "input" ? inputStatusEl : outputStatusEl;
      if (existingRoot && existingRoot.isConnected) return;

      selectEl.classList.add("hidden");
      const root = document.createElement("div");
      root.className = `midi-device-status midi-device-status-${kind}`;
      root.setAttribute("role", "status");
      root.setAttribute("aria-live", "polite");

      const display = document.createElement("span");
      display.className = "target-display";
      root.appendChild(display);

      selectEl.insertAdjacentElement("afterend", root);

      if (kind === "input") {
        inputStatusEl = root;
        inputStatusDisplayEl = display;
      } else {
        outputStatusEl = root;
        outputStatusDisplayEl = display;
        ensureOutputRouteShell();
      }
    };

    attachStatus(d.midiSelect, "input");
    attachStatus(d.midiOutputSelect, "output");

    if (!deviceDocClickBound) {
      deviceDocClickBound = true;
      document.addEventListener("click", (event) => {
        if (inputStatusEl && inputStatusEl.contains(event.target)) return;
        if (outputStatusEl && outputStatusEl.contains(event.target)) return;
        if (routesButtonEl && routesButtonEl.contains(event.target)) return;
        if (routesPopoverEl && routesPopoverEl.contains(event.target)) return;
        closeDeviceDropdowns();
      });
      window.addEventListener("resize", syncRoutesPopoverPosition);
    }

    ensureRoutesPopover();
    syncRoutesButtonLabel();
  }

  function renderDeviceStatus(root, displayEl, kind) {
    if (!root || !displayEl) return;
    const presentation = resolveMidiDeviceStatusPresentation({
      routes: connectedRoutes,
      kind,
      loading: initialDeviceLoadPending,
      translate: t,
    });
    const extraCount = Math.max(0, presentation.activeRoutes.length - 1);
    const additionalDevices = presentation.additionalDevices;
    const additionalDeviceList = additionalDevices.join(", ");
    const badges = extraCount > 0 ? [{
      text: `+${extraCount}`,
      kind: "count",
      title: additionalDeviceList,
      ariaLabel: additionalDeviceList,
    }] : [];
    renderLabelWithBadges(displayEl, {
      text: presentation.label,
      badges,
      truncate: true,
    });
    root.title = presentation.title;
    root.classList.toggle("device-loading", presentation.isLoading);
    root.classList.toggle("device-connected", presentation.activeRoutes.length > 0);
    root.classList.toggle("device-unavailable", !presentation.isLoading && presentation.activeRoutes.length === 0);
    root.classList.toggle("device-empty", !presentation.isLoading && presentation.activeRoutes.length === 0);
  }

  function renderDeviceDropdowns() {
    ensureDeviceDropdowns();
    renderDeviceStatus(inputStatusEl, inputStatusDisplayEl, "input");
    renderDeviceStatus(outputStatusEl, outputStatusDisplayEl, "output");
    syncRoutesButtonLabel();
    if (routesPopoverEl && !routesPopoverEl.classList.contains("hidden") && !isRouteDropdownOpen()) {
      renderRoutesPopover();
    }
  }

  function isRouteDropdownOpen() {
    return Boolean(routesPopoverEl?.querySelector?.(".midi-route-dropdown.open"));
  }

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
    const inputs = lastDeviceSnapshot.inputs || [];
    const outputs = lastDeviceSnapshot.outputs || [];
    return {
      ...route,
      inputDeviceName: deviceOptionLabel(inputs, route.inputDeviceId, route.inputDeviceName, "Input"),
      outputDeviceName: deviceOptionLabel(outputs, route.outputDeviceId, route.outputDeviceName, "Output"),
    };
  }

  function buildRouteSelect(kind, route, index) {
    const wrapper = document.createElement("div");
    wrapper.className = "midi-route-select-wrap";
    const devices = kind === "input" ? lastDeviceSnapshot.inputs : lastDeviceSnapshot.outputs;
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
    const selectedAvailableOption = options.find((option) => (
      option.id === selectedId
      && (!cleanSelectedName || option.name === cleanSelectedName)
    ));
    const selectedUnavailable = Boolean(selectedId && !selectedAvailableOption);
    if (selectedUnavailable) {
      options.push({
        id: selectedId,
        name: unavailableDeviceLabel(selectedName, selectedId, kind === "input" ? "Input" : "Output"),
        unavailable: true,
      });
    }

    const selectedOption = selectedAvailableOption
      || (selectedId ? options.find((option) => option.id === selectedId && option.unavailable) : null)
      || options[0];
    const root = document.createElement("div");
    root.className = "target-dropdown midi-route-dropdown settings-select-dropdown";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "target-button";
    button.title = placeholderText;
    button.disabled = routeEditorApplyInFlight;
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
      const optionMatchesSelection = option.id === selectedId
        && (option.unavailable || !cleanSelectedName || option.name === cleanSelectedName);
      optionButton.setAttribute("aria-selected", String(optionMatchesSelection));
      if (optionMatchesSelection) optionButton.classList.add("selected");
      if (option.unavailable) optionButton.classList.add("unavailable");
      if (routeEditorApplyInFlight || (option.disabled && !optionMatchesSelection)) {
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

  function markRouteEditorDirty(routes) {
    routeEditor.replace(routes);
    renderRoutesPopover();
  }

  function updateRouteFromSelect(index, kind, value) {
    const routes = currentRoutesForSave();
    const route = routes[index] || { enabled: true };
    const devices = kind === "input" ? lastDeviceSnapshot.inputs : lastDeviceSnapshot.outputs;
    const match = (Array.isArray(devices) ? devices : []).find((device) => device.id === value);
    const next = {
      ...route,
      enabled: route.enabled !== false,
      inputDeviceId: kind === "input" ? value : route.inputDeviceId,
      outputDeviceId: kind === "output" ? value : route.outputDeviceId,
      inputDeviceName: kind === "input" ? (match?.name || "") : route.inputDeviceName,
      outputDeviceName: kind === "output" ? (match?.name || "") : route.outputDeviceName,
    };
    routes[index] = next;
    if (kind === "input" && hasDuplicateInputRoute(routes, next.inputDeviceId, index)) {
      if (d.midiStatus) d.midiStatus.textContent = t("midi.duplicateInputRoute");
      renderRoutesPopover();
      return;
    }
    markRouteEditorDirty(routes);
  }

  function setRouteEnabled(index, enabled) {
    const routes = currentRoutesForSave();
    if (!routes[index]) return;
    routes[index] = { ...routes[index], enabled: Boolean(enabled) };
    markRouteEditorDirty(routes);
  }

  function removeRoute(index) {
    const routes = currentRoutesForSave();
    routes.splice(index, 1);
    markRouteEditorDirty(routes);
  }

  function addRoute() {
    const inputs = lastDeviceSnapshot.inputs || [];
    const outputs = lastDeviceSnapshot.outputs || [];
    const routes = currentRoutesForSave();
    const usedInputs = new Set(routes.map((route) => route.inputDeviceId));
    const input = inputs.find((device) => !usedInputs.has(device.id));
    const output = input
      ? (outputs.find((device) => device.name === input.name) || outputs[0])
      : null;
    if (!input || !output) {
      if (d.midiStatus) d.midiStatus.textContent = t("midi.noAvailableRoute");
      return;
    }
    routes.push({
      inputDeviceId: input.id,
      outputDeviceId: output.id,
      inputDeviceName: input.name,
      outputDeviceName: output.name,
      enabled: true,
    });
    markRouteEditorDirty(routes);
  }

  async function disableAllRoutes() {
    const routes = desiredRoutes().map((route) => ({ ...route, enabled: false }));
    discardRouteDrafts();
    await applyRoutes(routes, { source: "manual" });
    closeRoutesPopover({ discard: false });
  }

  async function applyRouteEdits() {
    if (routeEditorApplyInFlight || !routeEditor.isDirty()) return;
    const drafts = routeEditor.draft() || [];
    for (let index = 0; index < drafts.length; index += 1) {
      if (hasDuplicateInputRoute(drafts, drafts[index].inputDeviceId, index)) {
        if (d.midiStatus) d.midiStatus.textContent = t("midi.duplicateInputRoute");
        renderRoutesPopover();
        return;
      }
    }

    routeEditorApplyInFlight = true;
    renderRoutesPopover();
    try {
      await routeEditor.commit(async (routesToCommit) => {
        const snapshot = await refreshMidiDevices({ force: true, reason: "route_editor_apply" });
        const resolved = resolveDesiredRouteSet(
          snapshot,
          { routes: routesToCommit, configured: true },
          "route_editor_apply",
        );
        const result = await applyRoutes(routesFromResolvedPreferences(resolved), {
          source: "manual",
          allowPartialUnavailable: true,
          partialUnavailableStatus: unresolvedRouteStatus(resolved),
        });
        if (Array.isArray(result?.failures) && result.failures.length > 0) {
          throw new Error(result.failures[0]?.reason || "MIDI route did not connect");
        }
        return result;
      });
      routeEditorApplyInFlight = false;
      routeEditor.begin(desiredRoutes());
      renderRoutesPopover();
    } catch (error) {
      routeEditorApplyInFlight = false;
      if (d.midiStatus) d.midiStatus.textContent = t("midi.applyFailed", { message: error });
      renderRoutesPopover();
    }
  }

  function renderRoutesPopover() {
    if (!routesPopoverEl) return;
    syncRoutesPopoverPosition();
    const routes = currentRoutesForSave();
    const outputCounts = sharedOutputCounts(routes);
    routesPopoverEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "midi-routes-header";
    const title = document.createElement("div");
    title.className = "midi-routes-title";
    title.textContent = t("midi.routes");
    const actions = document.createElement("div");
    actions.className = "midi-routes-actions";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "midi-route-icon-button";
    close.title = t("common.close");
    close.setAttribute("aria-label", t("common.close"));
    close.disabled = routeEditorApplyInFlight;
    setIconButton(close, "close");
    close.addEventListener("click", closeRoutesPopover);
    actions.appendChild(close);
    header.appendChild(title);
    header.appendChild(actions);
    routesPopoverEl.appendChild(header);

    const body = document.createElement("div");
    body.className = "midi-routes-body";
    if (routes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "midi-routes-empty";
      empty.textContent = t("midi.noRoutes");
      body.appendChild(empty);
    } else {
      const columnHeader = document.createElement("div");
      columnHeader.className = "midi-route-column-header";
      columnHeader.setAttribute("aria-hidden", "true");
      columnHeader.appendChild(document.createElement("span"));

      const selectLabels = document.createElement("div");
      selectLabels.className = "midi-route-select-labels";
      const inputLabel = document.createElement("span");
      inputLabel.className = "midi-route-column-label";
      inputLabel.textContent = t("topbar.inputDevice");
      const outputLabel = document.createElement("span");
      outputLabel.className = "midi-route-column-label";
      outputLabel.textContent = t("topbar.outputDevice");
      selectLabels.appendChild(inputLabel);
      selectLabels.appendChild(outputLabel);
      columnHeader.appendChild(selectLabels);
      columnHeader.appendChild(document.createElement("span"));
      columnHeader.appendChild(document.createElement("span"));
      body.appendChild(columnHeader);
    }

    routes.forEach((rawRoute, index) => {
      const route = routeWithResolvedNames(rawRoute);
      const row = document.createElement("div");
      row.className = "midi-route-row";
      row.classList.toggle("disabled", route.enabled === false);

      const enableLabel = document.createElement("label");
      enableLabel.className = "plugins-toggle midi-route-enable";
      const enable = document.createElement("input");
      enable.type = "checkbox";
      enable.checked = route.enabled !== false;
      enable.disabled = routeEditorApplyInFlight;
      enable.addEventListener("change", () => setRouteEnabled(index, enable.checked));
      const enableUi = document.createElement("span");
      enableUi.className = "plugins-toggle-ui";
      enableLabel.appendChild(enable);
      enableLabel.appendChild(enableUi);
      row.appendChild(enableLabel);

      const selects = document.createElement("div");
      selects.className = "midi-route-selects";
      selects.appendChild(buildRouteSelect("input", route, index));
      selects.appendChild(buildRouteSelect("output", route, index));
      row.appendChild(selects);

      const badges = document.createElement("div");
      badges.className = "midi-route-badges";
      if ((outputCounts.get(route.outputDeviceId) || 0) > 1) {
        const shared = document.createElement("span");
        shared.className = "midi-route-badge";
        shared.textContent = t("midi.sharedOutput");
        badges.appendChild(shared);
      }
      row.appendChild(badges);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "midi-route-icon-button is-danger";
      remove.title = t("midi.removeRoute");
      remove.setAttribute("aria-label", t("midi.removeRoute"));
      remove.disabled = routeEditorApplyInFlight;
      setIconButton(remove, "trash");
      remove.addEventListener("click", () => removeRoute(index));
      row.appendChild(remove);
      body.appendChild(row);
    });
    routesPopoverEl.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "midi-routes-footer";
    const routeActions = document.createElement("div");
    routeActions.className = "midi-routes-footer-group";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "midi-route-action-button secondary-action";
    add.textContent = t("midi.addRoute");
    add.disabled = routeEditorApplyInFlight;
    add.addEventListener("click", addRoute);
    const disableAll = document.createElement("button");
    disableAll.type = "button";
    disableAll.className = "midi-route-action-button secondary-action";
    disableAll.textContent = t("midi.disconnectAll");
    disableAll.disabled = routeEditorApplyInFlight || !routes.some((route) => route.enabled !== false);
    disableAll.addEventListener("click", disableAllRoutes);
    routeActions.appendChild(add);
    routeActions.appendChild(disableAll);

    const commitActions = document.createElement("div");
    commitActions.className = "midi-routes-footer-group";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "midi-route-action-button secondary-action";
    cancel.textContent = t("common.cancel");
    cancel.disabled = routeEditorApplyInFlight;
    cancel.addEventListener("click", () => closeRoutesPopover());
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "midi-route-action-button primary-action";
    apply.textContent = t("midi.applyChanges");
    apply.disabled = routeEditorApplyInFlight || !routeEditor.isDirty();
    apply.addEventListener("click", applyRouteEdits);
    commitActions.appendChild(cancel);
    commitActions.appendChild(apply);

    footer.appendChild(routeActions);
    footer.appendChild(commitActions);
    routesPopoverEl.appendChild(footer);
  }

  function hasPreference(pref) {
    const normalized = normalizeMidiPreference(pref);
    return normalized.routes.length > 0;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function deviceInventorySignature(snapshot = {}) {
    const compact = {
      inputs: (Array.isArray(snapshot.inputs) ? snapshot.inputs : []).map((device) => ({
        id: String(device?.id || ""),
        name: String(device?.name || ""),
      })),
      outputs: (Array.isArray(snapshot.outputs) ? snapshot.outputs : []).map((device) => ({
        id: String(device?.id || ""),
        name: String(device?.name || ""),
      })),
    };
    return JSON.stringify(compact);
  }

  async function enumerateMidiDevices({ force = false, reason = "unknown" } = {}) {
    const now = Date.now();
    if (!force && now - lastDeviceRefreshAt < MIDI_ENUM_MIN_INTERVAL_MS) {
      return lastDeviceSnapshot;
    }
    if (deviceRefreshInFlight) {
      return deviceRefreshInFlight;
    }

    deviceRefreshInFlight = (async () => {
      try {
        const inputs = await invoke("list_midi_devices").catch((error) => {
          console.warn(`Failed to list MIDI inputs (${reason}):`, error);
          return lastDeviceSnapshot.inputs || [];
        });
        await sleep(MIDI_OUTPUT_ENUM_DELAY_MS);
        const outputs = await invoke("list_midi_output_devices").catch((error) => {
          console.warn(`Failed to list MIDI outputs (${reason}):`, error);
          return lastDeviceSnapshot.outputs || [];
        });
        lastDeviceSnapshot = {
          inputs: Array.isArray(inputs) ? inputs : [],
          outputs: Array.isArray(outputs) ? outputs : [],
        };
        const signature = deviceInventorySignature(lastDeviceSnapshot);
        if (signature !== lastDeviceInventorySignature) {
          lastDeviceInventorySignature = signature;
          if (typeof onDeviceInventoryChanged === "function") {
            onDeviceInventoryChanged(lastDeviceSnapshot);
          }
        }
        lastDeviceRefreshAt = Date.now();
        return lastDeviceSnapshot;
      } finally {
        deviceRefreshInFlight = null;
      }
    })();

    return deviceRefreshInFlight;
  }

  async function getMidiConnectionHealth() {
    try {
      return await invoke("get_midi_connection_health");
    } catch {
      return null;
    }
  }

  async function getMidiRouteHealth() {
    try {
      const health = await invoke("get_midi_route_health");
      return Array.isArray(health) ? health : [];
    } catch {
      const fallback = await getMidiConnectionHealth();
      return fallback ? [fallback] : [];
    }
  }

  function routeHealthNeedsRecovery(health) {
    return Boolean(
      health?.suspect
      || health?.inputSuspect
      || health?.inputNameMismatch
      || health?.outputSuspect
      || health?.outputNameMismatch
    );
  }

  function refreshDevicesIfStale(reason) {
    if (Date.now() - lastDeviceRefreshAt < MIDI_ENUM_STALE_MS) return;
    refreshMidiDevices({ force: true, reason }).catch(() => { });
  }

  function matchesConnectedPreference(pref) {
    const normalized = normalizeMidiPreference(pref);
    if (!normalized.inputDeviceId || !normalized.outputDeviceId) {
      return false;
    }
    if (connectedInputId !== normalized.inputDeviceId || connectedOutputId !== normalized.outputDeviceId) {
      return false;
    }
    // If profile stored names, require those to match as well to avoid false positives
    // when hot-plugging causes id/index reuse.
    if (normalized.inputDeviceName && connectedInputName && connectedInputName !== normalized.inputDeviceName) {
      return false;
    }
    if (normalized.outputDeviceName && connectedOutputName && connectedOutputName !== normalized.outputDeviceName) {
      return false;
    }
    return true;
  }

  async function startWithResolvedDevice(input, output, options = {}) {
    return applyRoutes([{
      inputDeviceId: input.id,
      outputDeviceId: output.id,
      inputDeviceName: input.name || options.inputName || "",
      outputDeviceName: output.name || options.outputName || "",
      enabled: true,
    }], {
      source: options.fromProfile ? "profile" : (options.auto ? "auto" : "manual"),
      auto: Boolean(options.auto),
      fromProfile: Boolean(options.fromProfile),
    });
  }

  function routesEquivalent(left, right) {
    const a = normalizeMidiRoutes({ routes: left });
    const b = normalizeMidiRoutes({ routes: right });
    if (a.length !== b.length) return false;
    return a.every((route, index) => {
      const other = b[index];
      return other
        && route.inputDeviceId === other.inputDeviceId
        && route.outputDeviceId === other.outputDeviceId
        && (route.enabled !== false) === (other.enabled !== false);
    });
  }

  async function applyRoutes(routes, options = {}) {
    const rawRoutes = Array.isArray(routes) ? routes : [];
    for (let index = 0; index < rawRoutes.length; index += 1) {
      const route = rawRoutes[index];
      const inputDeviceId = route?.inputDeviceId || route?.input_device_id || "";
      if (hasDuplicateInputRoute(rawRoutes, inputDeviceId, index)) {
        if (d.midiStatus) d.midiStatus.textContent = t("midi.duplicateInputRoute");
        renderDeviceDropdowns();
        return { connected: false, reason: "duplicate_input_route" };
      }
    }

    const requested = normalizeMidiRoutes({ routes });
    const normalized = routesFromResolvedPreferences(resolveDesiredRouteSet(
      lastDeviceSnapshot,
      { routes: requested, configured: true },
      options.source || "apply",
    ));
    const enabledRoutes = normalized.filter((route) => route.enabled !== false);
    const previousConnectedRoutes = connectedRoutes.slice();

    if (enabledRoutes.length === 0) {
      stopSessionRefresh();
      cancelLearnPanel();
      currentProfilePreference = normalizeMidiPreference({ routes: normalized, configured: true });
      setConnectedRoutes([]);
      if (d.midiStatus) d.midiStatus.textContent = t("midi.notConnected");
      if (typeof onDisconnected === "function") onDisconnected();
      renderDeviceDropdowns();
      await invoke("stop_midi_device").catch(() => { });
      if (typeof onProfileDeviceSelected === "function") {
        await onProfileDeviceSelected(currentProfilePreference);
      }
      return { connected: false, reason: "no_enabled_routes" };
    }

    const availableRoutes = enabledRoutes.filter((route) => {
      const inputAvailable = findPreferredDevice(lastDeviceSnapshot.inputs, route.inputDeviceId, route.inputDeviceName);
      const outputAvailable = findPreferredDevice(lastDeviceSnapshot.outputs, route.outputDeviceId, route.outputDeviceName);
      return Boolean(inputAvailable && outputAvailable);
    });
    const hasUnavailableRoutes = availableRoutes.length < enabledRoutes.length;
    const routesToStart = hasUnavailableRoutes && options.allowPartialUnavailable
      ? availableRoutes
      : enabledRoutes;
    if (hasUnavailableRoutes && (!options.allowPartialUnavailable || routesToStart.length === 0)) {
      if (d.midiStatus) {
        d.midiStatus.textContent = options.partialUnavailableStatus || t("midi.unavailablePair");
      }
      if (options.allowPartialUnavailable) {
        ensureUnavailableRouteOptions(lastDeviceSnapshot.inputs || [], lastDeviceSnapshot.outputs || []);
        currentProfilePreference = normalizeMidiPreference({ routes: normalized, configured: true });
        if (routesToStart.length === 0 && connectedRoutes.length > 0) {
          await invoke("stop_midi_device").catch(() => { });
          setConnectedRoutes([]);
          if (typeof onDisconnected === "function") onDisconnected();
        }
        if (typeof onProfileDeviceSelected === "function") {
          await onProfileDeviceSelected(currentProfilePreference);
        }
      }
      renderDeviceDropdowns();
      return {
        connected: connectedRoutes.length > 0,
        partial: Boolean(options.allowPartialUnavailable),
        reason: "unavailable_selection",
        routes: connectedRoutes.slice(),
      };
    }

    if (!options.force && routesEquivalent(routesToStart, connectedRoutes)) {
      if (hasUnavailableRoutes && d.midiStatus) {
        d.midiStatus.textContent = options.partialUnavailableStatus || t("midi.savedUnavailable");
      }
      renderDeviceDropdowns();
      currentProfilePreference = normalizeMidiPreference({ routes: normalized });
      if (typeof onProfileDeviceSelected === "function") {
        await onProfileDeviceSelected(currentProfilePreference);
      }
      return {
        connected: routesToStart.length > 0 || connectedRoutes.length > 0,
        unchanged: true,
        partial: hasUnavailableRoutes,
        routes: connectedRoutes.slice(),
      };
    }

    if (d.midiStatus) d.midiStatus.textContent = t("midi.applyingChange");
    const first = routesToStart[0] || enabledRoutes[0] || {};
    if (d.midiSelect) d.midiSelect.value = first.inputDeviceId || "";
    if (d.midiOutputSelect) d.midiOutputSelect.value = first.outputDeviceId || "";

    stopSessionRefresh();
    let applyResult = null;
    try {
      applyResult = await invoke("start_midi_device_routes", {
        routes: buildPersistedMidiRoutes(routesToStart),
        force: Boolean(options.force),
      });
    } catch (error) {
      setConnectedRoutes(previousConnectedRoutes);
      renderDeviceDropdowns();
      if (d.midiStatus) d.midiStatus.textContent = t("midi.connectFailed", { message: error });
      throw error;
    }

    const backendRoutes = normalizeMidiRoutes({
      routes: applyResult?.connectedRoutes || applyResult?.connected_routes || routesToStart,
    });
    setConnectedRoutes(orderMidiRoutesByPreference(
      backendRoutes.map(routeWithResolvedNames),
      normalized,
    ));
    const backendFailures = Array.isArray(applyResult?.failedRoutes)
      ? applyResult.failedRoutes
      : (Array.isArray(applyResult?.failed_routes) ? applyResult.failed_routes : []);
    const incompleteBackendApply = applyResult?.complete === false || backendFailures.length > 0;
    if (!incompleteBackendApply) {
      currentProfilePreference = normalizeMidiPreference({ routes: normalized });
      suspendProfileAutoReconnect = false;
      clearUnavailableDeviceSelections();
    }
    if ((hasUnavailableRoutes || incompleteBackendApply) && d.midiStatus) {
      d.midiStatus.textContent = options.partialUnavailableStatus || t("midi.partialRetrying");
    }

    if (typeof showMain === "function") {
      const count = connectedRoutes.length;
      showMain(connectedInputName, connectedOutputName, { routeCount: count, routes: connectedRoutes.slice() });
    }
    if (typeof refreshSessions === "function") {
      await refreshSessions();
    }
    startSessionRefresh(refreshSessions || (async () => { }), d.mainScreen);
    if (typeof onConnected === "function") {
      onConnected({
        inputId: connectedInputId,
        outputId: connectedOutputId,
        routes: connectedRoutes.slice(),
        source: options.source || "manual",
        auto: Boolean(options.auto),
        fromProfile: Boolean(options.fromProfile),
      });
    }
    if (!incompleteBackendApply && typeof onProfileDeviceSelected === "function") {
      await onProfileDeviceSelected(currentProfilePreference);
    }
    renderDeviceDropdowns();

    return {
      connected: connectedRoutes.length > 0,
      inputId: connectedInputId,
      outputId: connectedOutputId,
      inputName: connectedInputName,
      outputName: connectedOutputName,
      partial: hasUnavailableRoutes || incompleteBackendApply,
      routes: connectedRoutes.slice(),
      failures: backendFailures,
    };
  }

  async function applySelectedDevices({
    inputId,
    outputId,
    inputName = "",
    outputName = "",
    source = "manual",
    auto = false,
    fromProfile = false,
  } = {}) {
    const nextInputId = String(inputId || "").trim();
    const nextOutputId = String(outputId || "").trim();
    if (!nextInputId || !nextOutputId) {
      if (d.midiStatus) d.midiStatus.textContent = t("bindings.selectBothDevices");
      renderDeviceDropdowns();
      return { connected: false, reason: "invalid_selection" };
    }
    const inputUnavailable = Boolean(
      d.midiSelect?.selectedOptions?.[0]?.dataset?.unavailable === "true"
      && d.midiSelect?.value === nextInputId,
    );
    const outputUnavailable = Boolean(
      d.midiOutputSelect?.selectedOptions?.[0]?.dataset?.unavailable === "true"
      && d.midiOutputSelect?.value === nextOutputId,
    );
    if (inputUnavailable || outputUnavailable) {
      if (d.midiStatus) {
        d.midiStatus.textContent = t("midi.unavailablePair");
      }
      renderDeviceDropdowns();
      return { connected: false, reason: "unavailable_selection" };
    }

    if (nextInputId === connectedInputId && nextOutputId === connectedOutputId) {
      if (d.midiSelect) d.midiSelect.value = nextInputId;
      if (d.midiOutputSelect) d.midiOutputSelect.value = nextOutputId;
      clearUnavailableDeviceSelections();
      if (typeof showMain === "function") {
        showMain(connectedInputName || inputName, connectedOutputName || outputName);
      }
      renderDeviceDropdowns();
      return {
        connected: true,
        unchanged: true,
        inputId: connectedInputId,
        outputId: connectedOutputId,
        inputName: connectedInputName || inputName,
        outputName: connectedOutputName || outputName,
      };
    }

    const resolvedInputName = inputName
      || d.midiSelect?.options?.[d.midiSelect.selectedIndex]?.textContent
      || nextInputId;
    const resolvedOutputName = outputName
      || d.midiOutputSelect?.options?.[d.midiOutputSelect.selectedIndex]?.textContent
      || nextOutputId;

    return applyRoutes([{
      inputDeviceId: nextInputId,
      outputDeviceId: nextOutputId,
      inputDeviceName: resolvedInputName,
      outputDeviceName: resolvedOutputName,
      enabled: true,
    }], { source, auto, fromProfile });
  }

  function queueApplySelectedDevices(payload) {
    queuedApply = payload;
    processApplyQueue().catch(() => { });
  }

  async function processApplyQueue() {
    if (applyInFlight) return;
    applyInFlight = true;
    try {
      while (queuedApply) {
        const next = queuedApply;
        queuedApply = null;
        try {
          await applySelectedDevices(next);
        } catch (error) {
          if (d.midiStatus) {
            d.midiStatus.textContent = t("midi.connectFailed", { message: error });
          }
        }
      }
    } finally {
      applyInFlight = false;
    }
  }

  function getPreferredUnavailableLabels() {
    const pref = normalizeMidiPreference(currentProfilePreference);
    return {
      input: unavailableDeviceLabel(pref.inputDeviceName, pref.inputDeviceId, "Input"),
      output: unavailableDeviceLabel(pref.outputDeviceName, pref.outputDeviceId, "Output"),
    };
  }

  async function checkAvailabilityLoop() {
    if (availabilityCheckInFlight) return;
    availabilityCheckInFlight = true;
    try {
      const pref = normalizeMidiPreference(currentProfilePreference);
      const prefAvailable = hasPreference(pref);
      const currentlyConnected = connectedRoutes.length > 0;
      if (!prefAvailable && !currentlyConnected) return;

      const deviceSnapshot = await enumerateMidiDevices({ force: true, reason: "availability" });
      const devices = deviceSnapshot.inputs;
      const outputDevices = deviceSnapshot.outputs;

      if (currentlyConnected) {
        const routeHealth = await getMidiRouteHealth();
        const suspectRoute = routeHealth.find((health) =>
          routeHealthNeedsRecovery(health)
          && connectedRoutes.some((route) =>
            route.inputDeviceId === health.inputDeviceId
            && route.outputDeviceId === health.outputDeviceId
          )
        );
        if (suspectRoute && prefAvailable && !suspendProfileAutoReconnect) {
          try {
            let resolvedRoutes = resolveDesiredRouteSet(deviceSnapshot, pref, "suspect_reconnect");
            if (!resolvedRoutes.available) {
              const refreshed = await refreshMidiDevices({ force: true, reason: "suspect_reconnect" });
              resolvedRoutes = resolveDesiredRouteSet(refreshed, pref, "suspect_reconnect_retry");
            }
            const anyRouteAvailable = resolvedRoutes.routes.some((route) =>
              route.preference.enabled !== false && route.inputMatch && route.outputMatch
            );
            if (resolvedRoutes.available || anyRouteAvailable) {
              const result = await applyRoutes(routesFromResolvedPreferences(resolvedRoutes), {
                auto: true,
                fromProfile: true,
                allowPartialUnavailable: !resolvedRoutes.available,
                partialUnavailableStatus: unresolvedRouteStatus(resolvedRoutes),
              });
              if (d.midiStatus) {
                d.midiStatus.textContent = result?.partial
                  ? unresolvedRouteStatus(resolvedRoutes)
                  : t("midi.reconnectedProfile");
              }
              return;
            }
          } catch {
            const route = connectedRoutes.find((candidate) =>
              candidate.inputDeviceId === suspectRoute.inputDeviceId
              && candidate.outputDeviceId === suspectRoute.outputDeviceId
            ) || {};
            markSelectedPairUnavailable(
              suspectRoute.inputDeviceId,
              suspectRoute.outputDeviceId,
              route.inputDeviceName || suspectRoute.inputDeviceId,
              route.outputDeviceName || suspectRoute.outputDeviceId,
            );
            return;
          }
        }

        const aliveRoutes = [];
        const missingRoutes = [];
        connectedRoutes.forEach((route) => {
          const inputAlive = findConnectedAliveDevice(devices, route.inputDeviceId, route.inputDeviceName);
          const outputAlive = findConnectedAliveDevice(outputDevices, route.outputDeviceId, route.outputDeviceName);
          if (inputAlive && outputAlive) {
            aliveRoutes.push(route);
          } else {
            missingRoutes.push(route);
          }
        });

        if (missingRoutes.length > 0) {
          const preservedDrafts = preserveUnavailableRouteDrafts(aliveRoutes, missingRoutes);
          for (const route of missingRoutes) {
            await invoke("stop_midi_route", { inputDeviceId: route.inputDeviceId }).catch(() => { });
          }
          setConnectedRoutes(aliveRoutes.map(routeWithResolvedNames));
          currentProfilePreference = normalizeMidiPreference({ routes: preservedDrafts, configured: true });
          if (typeof showMain === "function") {
            const displayRoute = aliveRoutes[0] || missingRoutes[0] || {};
            showMain(
              displayRoute.inputDeviceName || displayRoute.inputDeviceId || pref.inputDeviceName,
              displayRoute.outputDeviceName || displayRoute.outputDeviceId || pref.outputDeviceName,
              {
                connected: aliveRoutes.length > 0,
                routeCount: aliveRoutes.length,
                routes: connectedRoutes.slice(),
              },
            );
          }
          if (d.midiStatus) {
            d.midiStatus.textContent = t("midi.partialRetrying");
          }
          if (aliveRoutes.length === 0) {
            stopSessionRefresh();
            if (typeof onDisconnected === "function") onDisconnected();
          }
          await refreshMidiDevices({ snapshot: deviceSnapshot, reason: "disconnect" });
        }
      }

      if (prefAvailable && !suspendProfileAutoReconnect) {
        let resolvedRoutes = resolveDesiredRouteSet(deviceSnapshot, pref, "availability");
        if (!resolvedRoutes.available) {
          const refreshed = await refreshMidiDevices({ snapshot: deviceSnapshot, reason: "reconnect_available" });
          resolvedRoutes = resolveDesiredRouteSet(refreshed, pref, "availability_retry");
        }
        const anyRouteAvailable = resolvedRoutes.routes.some((route) =>
          route.preference.enabled !== false && route.inputMatch && route.outputMatch
        );
        if (!resolvedRoutes.available && !anyRouteAvailable) {
          if (d.midiStatus) d.midiStatus.textContent = unresolvedRouteStatus(resolvedRoutes);
          return;
        }
        const routes = routesFromResolvedPreferences(resolvedRoutes);
        const availableEnabledRoutes = routes.filter((route) => (
          route.enabled !== false
          && findPreferredDevice(lastDeviceSnapshot.inputs, route.inputDeviceId, route.inputDeviceName)
          && findPreferredDevice(lastDeviceSnapshot.outputs, route.outputDeviceId, route.outputDeviceName)
        ));
        if (routesEquivalent(availableEnabledRoutes, connectedRoutes)) {
          currentProfilePreference = normalizeMidiPreference({ routes });
          if (typeof onProfileDeviceSelected === "function") {
            await onProfileDeviceSelected(currentProfilePreference);
          }
          renderDeviceDropdowns();
          return;
        }
        try {
          await applyRoutes(routes, {
            auto: true,
            fromProfile: true,
            allowPartialUnavailable: !resolvedRoutes.available,
            partialUnavailableStatus: unresolvedRouteStatus(resolvedRoutes),
          });
          if (d.midiStatus) {
            d.midiStatus.textContent = resolvedRoutes.available
              ? t("midi.reconnectedProfile")
              : unresolvedRouteStatus(resolvedRoutes);
          }
        } catch {
          // Ignore transient reconnect failures; watcher will retry.
        }
      }
    } finally {
      availabilityCheckInFlight = false;
    }
  }

  function startAvailabilityMonitor() {
    if (availabilityTimer) return;
    const enabledDesired = desiredRoutes().filter((route) => route.enabled !== false);
    const hasMissingDesiredRoute = enabledDesired.length > connectedRoutes.length
      || !routesEquivalent(enabledDesired, connectedRoutes);
    const delay = (!hasMissingDesiredRoute && connectedInputId && connectedOutputId)
      ? MIDI_AVAILABILITY_CONNECTED_INTERVAL_MS
      : MIDI_AVAILABILITY_DISCONNECTED_INTERVAL_MS;
    availabilityTimer = setTimeout(async () => {
      availabilityTimer = null;
      await checkAvailabilityLoop().catch(() => { });
      startAvailabilityMonitor();
    }, delay);
  }

  function startAutoRefresh(refreshFn) {
    if (autoRefreshTimer) {
      return;
    }
    autoRefreshTimer = setInterval(async () => {
      const devices = await refreshFn();
      if (devices.inputs.length > 0 && devices.outputs.length > 0) {
        await checkAvailabilityLoop().catch(() => { });
      }
      if (connectedInputId && connectedOutputId) {
        stopAutoRefresh();
      }
    }, MIDI_AUTO_REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  function startSessionRefresh(refreshFn, mainScreenEl) {
    sessionRefreshScheduler.start(refreshFn, mainScreenEl);
  }

  function stopSessionRefresh() {
    sessionRefreshScheduler.stop();
  }

  function closeLearnPanel() {
    if (!d.learnPanel) {
      return;
    }
    d.learnPanel.classList.add("hidden");
    if (d.learnPanelTitle) {
      d.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
    }
    if (d.learnPanelSpinner) {
      d.learnPanelSpinner.classList.remove("hidden");
    }
    if (d.learnPanelActions) {
      d.learnPanelActions.classList.add("hidden");
    }
  }

  function openLearnPanel(message) {
    if (!d.learnPanel) {
      return;
    }
    if (d.learnPanelTitle) {
      d.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
    }
    if (d.learnPanelSpinner) {
      d.learnPanelSpinner.classList.remove("hidden");
    }
    if (d.learnPanelActions) {
      d.learnPanelActions.classList.add("hidden");
    }
    if (d.learnPanelMessage && message) {
      d.learnPanelMessage.textContent = message;
    }
    d.learnPanel.classList.remove("hidden");
  }

  function cancelLearnPanel() {
    if (learnTimer) {
      clearInterval(learnTimer);
      learnTimer = null;
    }
    closeLearnPanel();
  }

  async function refreshMidiDevices(options = {}) {
    try {
      const snapshot = options.snapshot && typeof options.snapshot === "object"
        ? options.snapshot
        : await enumerateMidiDevices({
          force: Boolean(options.force),
          reason: options.reason || "refresh",
        });
      const devices = snapshot.inputs;
      const outputDevices = snapshot.outputs;

      const pref = normalizeMidiPreference(currentProfilePreference);
      const previousSelection = d.midiSelect
        ? (d.midiSelect.value || pref.inputDeviceId || connectedInputId)
        : (pref.inputDeviceId || connectedInputId);
      const previousOutputSelection = d.midiOutputSelect
        ? (d.midiOutputSelect.value || pref.outputDeviceId || connectedOutputId)
        : (pref.outputDeviceId || connectedOutputId);

      if (d.midiSelect) {
        d.midiSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("midi.selectInputDevice");
        d.midiSelect.appendChild(placeholder);
      }

      if (d.midiOutputSelect) {
        d.midiOutputSelect.innerHTML = "";
        const outPlaceholder = document.createElement("option");
        outPlaceholder.value = "";
        outPlaceholder.textContent = t("midi.selectOutputDevice");
        d.midiOutputSelect.appendChild(outPlaceholder);
      }

      if ((!devices || devices.length === 0) && (!outputDevices || outputDevices.length === 0)) {
        ensureUnavailableRouteOptions([], []);
        if (d.midiSelect && pref.inputDeviceId) d.midiSelect.value = pref.inputDeviceId;
        if (d.midiOutputSelect && pref.outputDeviceId) d.midiOutputSelect.value = pref.outputDeviceId;
        if (d.midiStatus) {
          d.midiStatus.textContent = t("midi.searchingDevices");
        }
        renderDeviceDropdowns();
        startAutoRefresh(refreshMidiDevices);
        return { inputs: [], outputs: [] };
      }

      (Array.isArray(devices) ? devices : []).forEach((device) => {
        if (!d.midiSelect) return;
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.name;
        d.midiSelect.appendChild(option);
      });

      (Array.isArray(outputDevices) ? outputDevices : []).forEach((device) => {
        if (!d.midiOutputSelect) return;
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = device.name;
        d.midiOutputSelect.appendChild(option);
      });

      ensureUnavailableRouteOptions(devices, outputDevices);

      if (d.midiSelect && previousSelection) {
        d.midiSelect.value = previousSelection;
      }
      if (d.midiOutputSelect && previousOutputSelection) {
        d.midiOutputSelect.value = previousOutputSelection;
      }

      if (d.midiStatus && !connectedInputId && !connectedOutputId) {
        d.midiStatus.textContent = t("midi.foundDevices", {
          inputs: (devices || []).length,
          outputs: (outputDevices || []).length,
        });
      }
      renderDeviceDropdowns();
      if (pref.inputDeviceId && pref.outputDeviceId && !connectedInputId && !connectedOutputId) {
        startAutoRefresh(refreshMidiDevices);
      } else {
        stopAutoRefresh();
      }
      return { inputs: Array.isArray(devices) ? devices : [], outputs: Array.isArray(outputDevices) ? outputDevices : [] };
    } catch (error) {
      if (d.midiStatus) {
        d.midiStatus.textContent = t("midi.error", { message: error });
      }
      renderDeviceDropdowns();
      startAutoRefresh(refreshMidiDevices);
      return { inputs: [], outputs: [] };
    }
  }

  async function connectSelected() {
    const inputId = d.midiSelect ? d.midiSelect.value : "";
    const outputId = d.midiOutputSelect ? d.midiOutputSelect.value : "";
    if (!inputId || !outputId) {
      if (d.midiStatus) {
        d.midiStatus.textContent = t("bindings.selectBothDevices");
      }
      renderDeviceDropdowns();
      return;
    }
    const inputs = lastDeviceSnapshot.inputs || [];
    const outputs = lastDeviceSnapshot.outputs || [];
    const input = inputs.find((device) => device.id === inputId);
    const output = outputs.find((device) => device.id === outputId);
    const routes = desiredRoutes();
    routes[0] = {
      inputDeviceId: inputId,
      outputDeviceId: outputId,
      inputDeviceName: input?.name || connectedInputName || inputId,
      outputDeviceName: output?.name || connectedOutputName || outputId,
      enabled: true,
    };
    await applyRoutes(routes, { source: "manual" });
  }

  async function disconnect() {
    stopSessionRefresh();
    stopAutoRefresh();
    cancelLearnPanel();
    const displayInputName = connectedInputName;
    const displayOutputName = connectedOutputName;
    await invoke("stop_midi_device").catch(() => { });
    setConnectedState("", "", "", "");
    if (typeof showMain === "function") {
      showMain(displayInputName, displayOutputName, { connected: false });
    }
    // User intentionally entered manual selection flow; do not auto-reconnect
    // to the profile's preferred device until they explicitly connect or a profile sync occurs.
    suspendProfileAutoReconnect = true;
    if (typeof clearSavedMidiDeviceIds === "function") {
      await clearSavedMidiDeviceIds();
    }
    currentProfilePreference = normalizeMidiPreference({ routes: [], configured: true });
    discardRouteDrafts();
    if (typeof onProfileDeviceSelected === "function") {
      await onProfileDeviceSelected(currentProfilePreference);
    }
    if (d.midiStatus) d.midiStatus.textContent = t("midi.notConnected");
    await refreshMidiDevices();
    if (typeof onDisconnected === "function") {
      onDisconnected();
    }
  }

  async function startLearnBinding() {
    try {
      await invoke("start_midi_learn");
      openLearnPanel(t("bindings.learnMessage"));
      if (learnTimer) {
        clearInterval(learnTimer);
      }
      learnTimer = setInterval(async () => {
        const learned = await invoke("consume_learned_control");
        if (!learned) {
          return;
        }
        clearInterval(learnTimer);
        learnTimer = null;
        if (typeof addBindingFromLearn === "function") {
          await addBindingFromLearn(learned);
        }
      }, LEARN_POLL_MS);
    } catch (error) {
      closeLearnPanel();
      if (d.learnPanelMessage && d.learnPanel && !d.learnPanel.classList.contains("hidden")) {
        d.learnPanelMessage.textContent = t("midi.learnFailed", { message: error });
      }
    }
  }

  async function loadMidiDevicesWithRetry() {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const devices = await refreshMidiDevices({ force: true, reason: `startup_attempt_${attempt + 1}` });
      if (devices.inputs.length > 0 && devices.outputs.length > 0) {
        return devices;
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
    startAutoRefresh(refreshMidiDevices);
    return { inputs: [], outputs: [] };
  }

  async function attemptAutoConnect(deviceData) {
    const saved = (typeof getSavedMidiDeviceIds === "function")
      ? getSavedMidiDeviceIds()
      : {};
    const savedInputId = saved?.inputId || "";
    const savedOutputId = saved?.outputId || "";
    const savedInputName = saved?.inputName || "";
    const savedOutputName = saved?.outputName || "";

    currentProfilePreference = normalizeMidiPreference({
      inputDeviceId: savedInputId,
      outputDeviceId: savedOutputId,
      inputDeviceName: savedInputName,
      outputDeviceName: savedOutputName,
      routes: saved?.routes || [],
    });

    const inputs = Array.isArray(deviceData?.inputs) ? deviceData.inputs : [];
    const outputs = Array.isArray(deviceData?.outputs) ? deviceData.outputs : [];
    const savedRoutes = currentProfilePreference.routes;

    if (savedRoutes.length === 0) {
      // First-run heuristic:
      // - if exactly one input exists, assume it
      // - prefer output with identical name; otherwise prefer a non-GS output
      if (inputs.length === 1 && outputs.length > 0) {
        const inputMatch = inputs[0];
        const outputMatch = outputs.find((o) => o?.name === inputMatch?.name)
          || outputs.find((o) => !String(o?.name || "").toLowerCase().includes("microsoft gs wavetable"))
          || outputs[0];

        if (inputMatch && outputMatch) {
          try {
            if (d.midiSelect) d.midiSelect.value = inputMatch.id;
            if (d.midiOutputSelect) d.midiOutputSelect.value = outputMatch.id;
            await startWithResolvedDevice(inputMatch, outputMatch, {
              inputName: inputMatch?.name || "",
              outputName: outputMatch?.name || "",
              auto: true,
            });
            if (d.midiStatus) d.midiStatus.textContent = t("midi.autoConnected");
            return { connected: true, autoSelected: true };
          } catch (error) {
            if (d.midiStatus) d.midiStatus.textContent = t("midi.connectFailed", { message: error });
            renderDeviceDropdowns();
            return { connected: false, reason: "auto_select_connect_failed" };
          }
        }
      }

      if (d.midiStatus) d.midiStatus.textContent = t("bindings.selectDevicesSentence");
      renderDeviceDropdowns();
      return { connected: false, reason: "missing_saved" };
    }

    let resolvedRoutes = resolveDesiredRouteSet(
      { inputs, outputs },
      currentProfilePreference,
      "startup",
    );

    if (!resolvedRoutes.available) {
      const refreshed = await refreshMidiDevices();
      resolvedRoutes = resolveDesiredRouteSet(refreshed, currentProfilePreference, "startup_retry");
    }

    const missingRoute = resolvedRoutes.routes.find((route) =>
      route.preference.enabled !== false && (!route.inputMatch || !route.outputMatch)
    );
    if (missingRoute) {
      if (d.midiStatus) {
        d.midiStatus.textContent = unresolvedRouteStatus(resolvedRoutes, "midi.savedUnavailable");
      }
      try {
        const result = await applyRoutes(routesFromResolvedPreferences(resolvedRoutes), {
          source: "auto",
          auto: true,
          allowPartialUnavailable: true,
          partialUnavailableStatus: unresolvedRouteStatus(resolvedRoutes, "midi.savedUnavailable"),
        });
        return {
          connected: Boolean(result?.connected),
          partial: true,
          reason: result?.connected ? "saved_missing_partial" : "saved_missing",
        };
      } catch (error) {
        if (d.midiStatus) {
          d.midiStatus.textContent = t("midi.connectFailed", { message: error });
        }
        renderDeviceDropdowns();
        return { connected: false, reason: "saved_missing_connect_failed" };
      }
    }

    try {
      const routes = routesFromResolvedPreferences(resolvedRoutes);
      const first = routes.find((route) => route.enabled !== false) || routes[0] || {};
      if (d.midiSelect) d.midiSelect.value = first.inputDeviceId || "";
      if (d.midiOutputSelect) d.midiOutputSelect.value = first.outputDeviceId || "";
      await applyRoutes(routes, { source: "auto", auto: true });
      return { connected: true };
    } catch (error) {
      setConnectedState("", "", "", "");
      if (d.midiStatus) {
        d.midiStatus.textContent = t("midi.connectFailed", { message: error });
      }
      renderDeviceDropdowns();
      return { connected: false };
    }
  }

  async function syncToProfileDevice(profilePreference) {
    const pref = normalizeMidiPreference(profilePreference);
    discardRouteDrafts();
    if (routesPopoverEl && !routesPopoverEl.classList.contains("hidden")) {
      closeRoutesPopover({ discard: false });
    }
    currentProfilePreference = pref;
    suspendProfileAutoReconnect = false;
    if (pref.routes.length === 0) {
      if (pref.configured) {
        await applyRoutes([], { source: "profile", fromProfile: true });
        return { handled: true, connected: false, reason: "no_profile_routes" };
      }
      return { handled: false, connected: false };
    }

    if (routesEquivalent(pref.routes.filter((route) => route.enabled !== false), connectedRoutes)) {
      // Profile switch can leave the visible dropdown on a previously selected
      // unavailable device even when the active connection already matches this profile.
      // Force UI selection back to the profile's connected pair.
      if (d.midiSelect) d.midiSelect.value = pref.inputDeviceId;
      if (d.midiOutputSelect) d.midiOutputSelect.value = pref.outputDeviceId;
      clearUnavailableDeviceSelections();
      renderDeviceDropdowns();
      return { handled: true, connected: true, unchanged: true };
    }

    const devices = await refreshMidiDevices({ force: true, reason: "profile_sync" });
    let resolvedRoutes = resolveDesiredRouteSet(devices, pref, "profile_sync");

    if (!resolvedRoutes.available) {
      const refreshed = await refreshMidiDevices({ force: true, reason: "profile_sync_retry" });
      resolvedRoutes = resolveDesiredRouteSet(refreshed, pref, "profile_sync_retry");
    }

    const missingRoute = resolvedRoutes.routes.find((route) =>
      route.preference.enabled !== false && (!route.inputMatch || !route.outputMatch)
    );
    if (missingRoute) {
      const partialStatus = unresolvedRouteStatus(resolvedRoutes);
      if (d.midiStatus) {
        d.midiStatus.textContent = partialStatus;
      }
      try {
        const result = await applyRoutes(routesFromResolvedPreferences(resolvedRoutes), {
          source: "profile",
          auto: true,
          fromProfile: true,
          allowPartialUnavailable: true,
          partialUnavailableStatus: partialStatus,
        });
        return {
          handled: true,
          connected: Boolean(result?.connected),
          partial: true,
          reason: "missing",
        };
      } catch (error) {
        if (d.midiStatus) d.midiStatus.textContent = t("midi.connectFailed", { message: error });
        renderDeviceDropdowns();
        return { handled: true, connected: false, reason: "connect_failed" };
      }
    }

    try {
      const routes = routesFromResolvedPreferences(resolvedRoutes);
      await applyRoutes(routes, { source: "profile", auto: true, fromProfile: true });
      return { handled: true, connected: true };
    } catch (error) {
      if (d.midiStatus) d.midiStatus.textContent = t("midi.connectFailed", { message: error });
      renderDeviceDropdowns();
      return { handled: true, connected: false, reason: "connect_failed" };
    }
  }

  function bindUi() {
    if (uiBound) return;
    uiBound = true;
    startAvailabilityMonitor();
    ensureDeviceDropdowns();
    renderDeviceDropdowns();
    if (d.learnPanel) {
      d.learnPanel.addEventListener("click", (event) => {
        if (event.target === d.learnPanel) {
          cancelLearnPanel();
        }
      });
    }
    if (d.learnPanelClose) {
      d.learnPanelClose.addEventListener("click", cancelLearnPanel);
    }

    if (d.refreshMidiButton) {
      d.refreshMidiButton.addEventListener("click", async () => {
        await refreshMidiDevices({ force: true, reason: "manual_refresh" });
      });
    }
    if (d.learnBindingButton) {
      d.learnBindingButton.addEventListener("click", () => {
        startLearnBinding();
      });
    }
    if (d.bindingAddFooterButton) {
      d.bindingAddFooterButton.addEventListener("click", () => {
        startLearnBinding();
      });
    }
    window.addEventListener("midimaster:locale-changed", () => {
      renderDeviceDropdowns();
      if (d.learnPanel && !d.learnPanel.classList.contains("hidden") && d.learnPanelTitle) {
        d.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
      }
    });
  }

  function completeInitialDeviceLoad() {
    if (!initialDeviceLoadPending) return;
    initialDeviceLoadPending = false;
    renderDeviceDropdowns();
  }

  return {
    bindUi,
    refreshMidiDevices,
    loadMidiDevicesWithRetry,
    attemptAutoConnect,
    startSessionRefresh: () => startSessionRefresh(refreshSessions || (async () => { }), d.mainScreen),
    stopSessionRefresh,
    startLearnBinding,
    openLearnPanel,
    closeLearnPanel,
    cancelLearnPanel,
    connectSelected,
    disconnect,
    syncToProfileDevice,
    completeInitialDeviceLoad,
    getDesiredMidiPreference,
    checkAvailabilityNow: checkAvailabilityLoop,
  };
}
