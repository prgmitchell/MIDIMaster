import { hasDuplicateInputRoute, sharedOutputCounts } from "../device_preferences.js";
import { routesFromResolvedPreferences } from "../route_policy.js";

/** route editor workflow. */
export function createRouteEditor({
  applyRoutes,
  buildRouteSelect,
  closeRoutesPopover,
  currentRoutesForSave,
  elements,
  desiredRoutes,
  discardRouteDrafts,
  discovery,
  refreshMidiDevices,
  resolveDesiredRouteSet,
  routeEditor,
  routeView,
  routeWithResolvedNames,
  setIconButton,
  syncRoutesPopoverPosition,
  t,
  unresolvedRouteStatus,
}) {
  function markRouteEditorDirty(routes) {
    routeEditor.replace(routes);
    renderRoutesPopover();
  }

  function updateRouteFromSelect(index, kind, value) {
    const routes = currentRoutesForSave();
    const route = routes[index] || { enabled: true };
    const devices =
      kind === "input" ? discovery.lastDeviceSnapshot.inputs : discovery.lastDeviceSnapshot.outputs;
    const match = (Array.isArray(devices) ? devices : []).find((device) => device.id === value);
    const next = {
      ...route,
      enabled: route.enabled !== false,
      inputDeviceId: kind === "input" ? value : route.inputDeviceId,
      outputDeviceId: kind === "output" ? value : route.outputDeviceId,
      inputDeviceName: kind === "input" ? match?.name || "" : route.inputDeviceName,
      outputDeviceName: kind === "output" ? match?.name || "" : route.outputDeviceName,
    };
    routes[index] = next;
    if (kind === "input" && hasDuplicateInputRoute(routes, next.inputDeviceId, index)) {
      if (elements.midiStatus) elements.midiStatus.textContent = t("midi.duplicateInputRoute");
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
    const inputs = discovery.lastDeviceSnapshot.inputs || [];
    const outputs = discovery.lastDeviceSnapshot.outputs || [];
    const routes = currentRoutesForSave();
    const usedInputs = new Set(routes.map((route) => route.inputDeviceId));
    const input = inputs.find((device) => !usedInputs.has(device.id));
    const output = input ? outputs.find((device) => device.name === input.name) || outputs[0] : null;
    if (!input || !output) {
      if (elements.midiStatus) elements.midiStatus.textContent = t("midi.noAvailableRoute");
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
    if (routeView.routeEditorApplyInFlight || !routeEditor.isDirty()) return;
    const drafts = routeEditor.draft() || [];
    for (let index = 0; index < drafts.length; index += 1) {
      if (hasDuplicateInputRoute(drafts, drafts[index].inputDeviceId, index)) {
        if (elements.midiStatus) elements.midiStatus.textContent = t("midi.duplicateInputRoute");
        renderRoutesPopover();
        return;
      }
    }

    routeView.routeEditorApplyInFlight = true;
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
      routeView.routeEditorApplyInFlight = false;
      routeEditor.begin(desiredRoutes());
      renderRoutesPopover();
    } catch (error) {
      routeView.routeEditorApplyInFlight = false;
      if (elements.midiStatus) elements.midiStatus.textContent = t("midi.applyFailed", { message: error });
      renderRoutesPopover();
    }
  }

  function renderRoutesPopover() {
    if (!routeView.routesPopoverEl) return;
    syncRoutesPopoverPosition();
    const routes = currentRoutesForSave();
    const outputCounts = sharedOutputCounts(routes);
    routeView.routesPopoverEl.innerHTML = "";

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
    close.disabled = routeView.routeEditorApplyInFlight;
    setIconButton(close, "close");
    close.addEventListener("click", closeRoutesPopover);
    actions.appendChild(close);
    header.appendChild(title);
    header.appendChild(actions);
    routeView.routesPopoverEl.appendChild(header);

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
      enable.disabled = routeView.routeEditorApplyInFlight;
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
      remove.disabled = routeView.routeEditorApplyInFlight;
      setIconButton(remove, "trash");
      remove.addEventListener("click", () => removeRoute(index));
      row.appendChild(remove);
      body.appendChild(row);
    });
    routeView.routesPopoverEl.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "midi-routes-footer";
    const routeActions = document.createElement("div");
    routeActions.className = "midi-routes-footer-group";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "midi-route-action-button secondary-action";
    add.textContent = t("midi.addRoute");
    add.disabled = routeView.routeEditorApplyInFlight;
    add.addEventListener("click", addRoute);
    const disableAll = document.createElement("button");
    disableAll.type = "button";
    disableAll.className = "midi-route-action-button secondary-action";
    disableAll.textContent = t("midi.disconnectAll");
    disableAll.disabled =
      routeView.routeEditorApplyInFlight || !routes.some((route) => route.enabled !== false);
    disableAll.addEventListener("click", disableAllRoutes);
    routeActions.appendChild(add);
    routeActions.appendChild(disableAll);

    const commitActions = document.createElement("div");
    commitActions.className = "midi-routes-footer-group";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "midi-route-action-button secondary-action";
    cancel.textContent = t("common.cancel");
    cancel.disabled = routeView.routeEditorApplyInFlight;
    cancel.addEventListener("click", () => closeRoutesPopover());
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "midi-route-action-button primary-action";
    apply.textContent = t("midi.applyChanges");
    apply.disabled = routeView.routeEditorApplyInFlight || !routeEditor.isDirty();
    apply.addEventListener("click", applyRouteEdits);
    commitActions.appendChild(cancel);
    commitActions.appendChild(apply);

    footer.appendChild(routeActions);
    footer.appendChild(commitActions);
    routeView.routesPopoverEl.appendChild(footer);
  }

  return { updateRouteFromSelect, renderRoutesPopover };
}
