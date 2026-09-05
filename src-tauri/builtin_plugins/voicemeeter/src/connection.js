import { shouldPollMeters, bindingUiSignature, shouldRenderConnectionTransition } from "./protocol.js";

/** connection workflow. */
export function createConnection({ ctx, poll, renderDashboard, state }) {
  function dashboardIsVisible() {
    const tab = state.ui.root?.closest?.(".connection-tab");
    const page = state.ui.root?.closest?.("[data-page-panel]");
    return shouldPollMeters({
      mounted: state.mounted,
      documentHidden: document.hidden,
      tabActive: tab?.classList.contains("active"),
      pageActive: page?.classList.contains("active"),
    });
  }

  function updateStatusUi(detail = null) {
    const connected = Boolean(state.status.connected);
    const statusUiSignature = JSON.stringify([
      connected,
      state.connecting,
      state.status.installed,
      state.status.edition,
      state.status.version,
      detail || state.status.detail,
    ]);
    if (statusUiSignature !== state.lastStatusUiSignature) {
      state.lastStatusUiSignature = statusUiSignature;
      if (state.ui.status)
        state.ui.status.textContent =
          detail || state.status.detail || (connected ? "Connected" : "Not connected");
      state.ui.dot?.classList.toggle("connected", connected);
      state.ui.dot?.classList.toggle("connecting", !connected && state.connecting);
      state.ui.dot?.classList.toggle(
        "error",
        !connected && !state.connecting && state.status.installed === false,
      );
      if (state.ui.connect) {
        state.ui.connect.textContent = state.connecting
          ? "Connecting…"
          : connected
            ? "Disconnect"
            : "Connect";
        state.ui.connect.disabled = state.connecting;
        state.ui.connect.classList.toggle("danger", connected);
      }
      if (state.ui.edition) {
        const edition = state.status.edition
          ? `${state.status.edition[0].toUpperCase()}${state.status.edition.slice(1)}`
          : "—";
        state.ui.edition.textContent = state.status.version ? `${edition} ${state.status.version}` : edition;
      }
    }
    const nextBindingUiSignature = bindingUiSignature(state);
    if (nextBindingUiSignature !== state.lastBindingUiSignature) {
      state.lastBindingUiSignature = nextBindingUiSignature;
      ctx.app.invalidateBindingsUI();
    }
  }

  async function refreshDevices() {
    if (!state.status.connected) return;
    const [input, output] = await Promise.all([
      ctx.tauri.invoke("voicemeeter_list_devices", { direction: "input" }).catch(() => []),
      ctx.tauri.invoke("voicemeeter_list_devices", { direction: "output" }).catch(() => []),
    ]);
    state.devices = { input: Array.isArray(input) ? input : [], output: Array.isArray(output) ? output : [] };
  }

  async function connect({ manual = false } = {}) {
    if (state.connecting || state.disposed) return false;
    const wasConnected = Boolean(state.status.connected);
    let renderConnectedDashboard = false;
    state.connecting = true;
    if (manual) state.disconnectedByUser = false;
    if (manual) updateStatusUi("Connecting…");
    try {
      state.status = await ctx.tauri.invoke("voicemeeter_connect");
      if (state.status.connected) {
        state.consecutivePollFailures = 0;
        if (!wasConnected) state.confirmedDevices.clear();
        await refreshDevices();
        await poll(true);
        renderConnectedDashboard = shouldRenderConnectionTransition(wasConnected, true);
      }
      return Boolean(state.status.connected);
    } catch (error) {
      state.status = { ...state.status, connected: false, detail: String(error) };
      if (manual) updateStatusUi(String(error));
      return false;
    } finally {
      state.connecting = false;
      if (renderConnectedDashboard) renderDashboard();
      else updateStatusUi();
    }
  }

  async function disconnect({ manual = true } = {}) {
    if (manual) state.disconnectedByUser = true;
    state.pendingWrites.clear();
    state.consecutivePollFailures = 0;
    try {
      await ctx.tauri.invoke("voicemeeter_disconnect");
    } catch {
      /* already disconnected */
    }
    state.localIntents.clear();
    state.deviceRequestGenerations.clear();
    state.confirmedDevices.clear();
    state.status = { ...state.status, connected: false, detail: "Not connected" };
    updateStatusUi();
    renderDashboard();
  }

  return { dashboardIsVisible, updateStatusUi, refreshDevices, connect, disconnect };
}
