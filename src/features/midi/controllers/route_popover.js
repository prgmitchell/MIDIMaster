import { closeOpenDropdowns, renderLabelWithBadges } from "../../ui/dropdown_badges.js";
import { routesFromResolvedPreferences } from "../route_policy.js";

/** route popover workflow. */
export function createRoutePopover({
  lifetime,
  connection,
  currentRoutesForSave,
  elements,
  desiredRoutes,
  discovery,
  refreshMidiDevices,
  renderRoutesPopover,
  resolveDesiredRouteSet,
  resolveMidiDeviceStatusPresentation,
  routeEditor,
  routeView,
  t,
}) {
  function closeDeviceDropdowns() {
    closeOpenDropdowns({ except: null });
    closeRoutesPopover();
  }

  function discardRouteDrafts() {
    routeEditor.discard();
  }

  function closeRoutesPopover({ discard = true } = {}) {
    if (discard) discardRouteDrafts();
    if (routeView.routesPopoverEl) routeView.routesPopoverEl.classList.add("hidden");
    if (routeView.routesButtonEl) routeView.routesButtonEl.setAttribute("aria-expanded", "false");
    renderDeviceDropdowns();
  }

  async function toggleRoutesPopover() {
    ensureRoutesPopover();
    const opening = routeView.routesPopoverEl?.classList?.contains("hidden");
    if (!opening) {
      closeRoutesPopover();
      return;
    }
    const cachedResolution = resolveDesiredRouteSet(
      discovery.lastDeviceSnapshot,
      { routes: desiredRoutes(), configured: true },
      "route_editor_open_cached",
    );
    routeEditor.begin(routesFromResolvedPreferences(cachedResolution));
    if (routeView.routesPopoverEl) routeView.routesPopoverEl.classList.remove("hidden");
    if (routeView.routesButtonEl) routeView.routesButtonEl.setAttribute("aria-expanded", "true");
    renderRoutesPopover();

    void refreshMidiDevices({ force: true, reason: "route_editor_open" }).then((snapshot) => {
      if (routeView.routesPopoverEl?.classList?.contains("hidden") || routeEditor.isDirty()) return;
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
    if (!routeView.routesButtonEl && elements.midiOutputSelect) {
      routeView.routesButtonEl = document.createElement("button");
      routeView.routesButtonEl.type = "button";
      routeView.routesButtonEl.className = "midi-routes-button";
      routeView.routesButtonEl.title = t("midi.routes");
      routeView.routesButtonEl.setAttribute("aria-label", t("midi.routes"));
      routeView.routesButtonEl.setAttribute("aria-haspopup", "dialog");
      routeView.routesButtonEl.setAttribute("aria-expanded", "false");
      lifetime.listen(routeView.routesButtonEl, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleRoutesPopover().catch(() => {});
      });
    }
    ensureOutputRouteShell();

    if (!routeView.routesPopoverEl) {
      routeView.routesPopoverEl = document.createElement("div");
      routeView.routesPopoverEl.className = "midi-routes-popover hidden";
      routeView.routesPopoverEl.setAttribute("role", "dialog");
      routeView.routesPopoverEl.setAttribute("aria-label", t("midi.routes"));
      lifetime.listen(routeView.routesPopoverEl, "click", (event) => {
        event.stopPropagation();
      });
      document.body.appendChild(routeView.routesPopoverEl);
    }
    syncRoutesPopoverPosition();
  }

  function ensureOutputRouteShell() {
    const outputRoot = routeView.outputStatusEl || elements.midiOutputSelect;
    if (!outputRoot || !routeView.routesButtonEl) return;

    const existingShell = outputRoot.closest?.(".midi-output-route-shell");
    routeView.outputRouteShellEl = existingShell || routeView.outputRouteShellEl;
    if (!routeView.outputRouteShellEl || !routeView.outputRouteShellEl.isConnected) {
      routeView.outputRouteShellEl = document.createElement("div");
      routeView.outputRouteShellEl.className = "midi-output-route-shell";
      outputRoot.parentNode?.insertBefore(routeView.outputRouteShellEl, outputRoot);
      routeView.outputRouteShellEl.appendChild(outputRoot);
    }

    if (routeView.routesButtonEl.parentElement !== routeView.outputRouteShellEl) {
      routeView.outputRouteShellEl.appendChild(routeView.routesButtonEl);
    }
  }

  function syncRoutesButtonLabel() {
    if (!routeView.routesButtonEl) return;
    const count = currentRoutesForSave().filter((route) => route.enabled !== false).length;
    routeView.routesButtonEl.replaceChildren(createRouteIcon("sliders"));
    routeView.routesButtonEl.dataset.routeCount = count > 1 ? String(count) : "";
    routeView.routesButtonEl.classList.toggle("has-multiple-routes", count > 1);
    routeView.routesButtonEl.title = t("midi.routesCount", { count });
    routeView.routesButtonEl.setAttribute("aria-label", t("midi.routesCount", { count }));
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
      sliders: [
        "M4 21v-7",
        "M4 10V3",
        "M12 21v-9",
        "M12 8V3",
        "M20 21v-5",
        "M20 12V3",
        "M2 14h4",
        "M10 8h4",
        "M18 16h4",
      ],
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
    if (!routeView.routesPopoverEl || !routeView.routesButtonEl) return;
    const rect = routeView.routesButtonEl.getBoundingClientRect();
    const viewportPadding = 16;
    const popoverWidth = Math.min(520, Math.max(0, window.innerWidth - viewportPadding * 2));
    const maxLeft = Math.max(viewportPadding, window.innerWidth - popoverWidth - viewportPadding);
    const left = Math.max(viewportPadding, Math.min(rect.left, maxLeft));
    routeView.routesPopoverEl.style.top = `${Math.round(rect.bottom + 8)}px`;
    routeView.routesPopoverEl.style.left = `${Math.round(left)}px`;
  }

  function ensureDeviceDropdowns() {
    if (!elements.midiSelect && !elements.midiOutputSelect) return;
    const attachStatus = (selectEl, kind) => {
      if (!selectEl) return;

      let existingRoot = kind === "input" ? routeView.inputStatusEl : routeView.outputStatusEl;
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
        routeView.inputStatusEl = root;
        routeView.inputStatusDisplayEl = display;
      } else {
        routeView.outputStatusEl = root;
        routeView.outputStatusDisplayEl = display;
        ensureOutputRouteShell();
      }
    };

    attachStatus(elements.midiSelect, "input");
    attachStatus(elements.midiOutputSelect, "output");

    if (!routeView.deviceDocClickBound) {
      routeView.deviceDocClickBound = true;
      lifetime.listen(document, "click", (event) => {
        if (routeView.inputStatusEl && routeView.inputStatusEl.contains(event.target)) return;
        if (routeView.outputStatusEl && routeView.outputStatusEl.contains(event.target)) return;
        if (routeView.routesButtonEl && routeView.routesButtonEl.contains(event.target)) return;
        if (routeView.routesPopoverEl && routeView.routesPopoverEl.contains(event.target)) return;
        closeDeviceDropdowns();
      });
      lifetime.listen(window, "resize", syncRoutesPopoverPosition);
    }

    ensureRoutesPopover();
    syncRoutesButtonLabel();
  }

  function renderDeviceStatus(root, displayEl, kind) {
    if (!root || !displayEl) return;
    const presentation = resolveMidiDeviceStatusPresentation({
      routes: connection.connectedRoutes,
      kind,
      loading: discovery.initialDeviceLoadPending,
      translate: t,
    });
    const extraCount = Math.max(0, presentation.activeRoutes.length - 1);
    const additionalDevices = presentation.additionalDevices;
    const additionalDeviceList = additionalDevices.join(", ");
    const badges =
      extraCount > 0
        ? [
            {
              text: `+${extraCount}`,
              kind: "count",
              title: additionalDeviceList,
              ariaLabel: additionalDeviceList,
            },
          ]
        : [];
    renderLabelWithBadges(displayEl, {
      text: presentation.label,
      badges,
      truncate: true,
    });
    root.title = presentation.title;
    root.classList.toggle("device-loading", presentation.isLoading);
    root.classList.toggle("device-connected", presentation.activeRoutes.length > 0);
    root.classList.toggle(
      "device-unavailable",
      !presentation.isLoading && presentation.activeRoutes.length === 0,
    );
    root.classList.toggle("device-empty", !presentation.isLoading && presentation.activeRoutes.length === 0);
  }

  function renderDeviceDropdowns() {
    ensureDeviceDropdowns();
    renderDeviceStatus(routeView.inputStatusEl, routeView.inputStatusDisplayEl, "input");
    renderDeviceStatus(routeView.outputStatusEl, routeView.outputStatusDisplayEl, "output");
    syncRoutesButtonLabel();
    if (
      routeView.routesPopoverEl &&
      !routeView.routesPopoverEl.classList.contains("hidden") &&
      !isRouteDropdownOpen()
    ) {
      renderRoutesPopover();
    }
  }

  function isRouteDropdownOpen() {
    return Boolean(routeView.routesPopoverEl?.querySelector?.(".midi-route-dropdown.open"));
  }

  return {
    discardRouteDrafts,
    closeRoutesPopover,
    setIconButton,
    syncRoutesPopoverPosition,
    ensureDeviceDropdowns,
    renderDeviceDropdowns,
  };
}
