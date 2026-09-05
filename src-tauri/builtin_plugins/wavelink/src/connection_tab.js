import { ui, setStatus, lastStatus } from "./protocol.js";

/** connection tab workflow. */
export function createConnectionTab({
  applyProfileSettings,
  clearPendingAppInfo,
  connectOnce,
  ctx,
  iconDataUrl,
  localVolumeIntentByEndpoint,
  pendingVolumeWrites,
  state,
  syncOfflineFeedback,
  updateAppInfoUi,
}) {
  function registerConnectionTab() {
    ctx.connections?.registerTab?.({
      id: "wavelink",
      name: "Wave Link",
      icon_data: iconDataUrl || null,
      order: 20,
      mount: (container) => {
        container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="Wave Link" class="connection-icon" />
            <span class="connection-name">Wave Link</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot" data-role="dot"></span>
            <span data-role="text">Not connected</span>
          </div>
        </div>
        <div class="connection-content-wrapper">
          <div class="connection-description">
            <p>Control Elgato Wave Link inputs, outputs, and monitor mix directly from your MIDI device.</p>
            <p>Ensure Wave Link is running. Use auto connect to reconnect on startup.</p>
            <p data-role="app-info">Wave Link app info unavailable.</p>
          </div>
        </div>
        <div class="connection-footer">
          <button type="button" class="connection-button" data-role="connect">Connect</button>
          <div class="connection-row checkbox-row">
            <input type="checkbox" data-role="auto" id="wavelink-auto-connect" />
            <label for="wavelink-auto-connect">Auto connect</label>
          </div>
        </div>
      `;
        ui.statusText = container.querySelector('[data-role="text"]');
        ui.statusDot = container.querySelector('[data-role="dot"]');
        ui.connectBtn = container.querySelector('[data-role="connect"]');
        ui.appInfoText = container.querySelector('[data-role="app-info"]');
        ui.autoConnectInput = container.querySelector('[data-role="auto"]');
        ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;
        updateAppInfoUi();

        applyProfileSettings(ctx.profile?.get?.());
        if (ui.autoConnectInput) {
          ui.autoConnectInput.addEventListener("change", () => {
            const next = Boolean(ui.autoConnectInput.checked);
            applyProfileSettings({ auto_connect: next });
            try {
              const current = ctx.profile?.get?.() || {};
              ctx.profile?.set?.({ ...current, auto_connect: next });
            } catch {}
          });
        }

        if (ui.connectBtn) {
          ui.connectBtn.addEventListener("click", () => {
            if (state.connecting) return;
            if (state.wsId) {
              state.disconnectedByUser = true;
              state.manualConnectRequested = false;
              try {
                ctx.ws?.close?.(state.wsId);
              } catch {}
              clearPendingAppInfo(state.wsId);
              state.wsId = null;
              state.connectedPort = null;
              state.connecting = false;
              pendingVolumeWrites.clear();
              state.mixes = [];
              state.channels = [];
              state.outputDevicesState = { mainOutput: null, outputDevices: [] };
              localVolumeIntentByEndpoint.clear();
              state.offlineFeedbackSent = false;
              syncOfflineFeedback().catch(() => {});
              state.wasConnected = false;
              setStatus(false, "Disconnected", { disconnectedByUser: true });
              return;
            }

            state.disconnectedByUser = false;
            state.manualConnectRequested = true;
            connectOnce().catch(() => {
              if (state.disposed) return;
              state.connecting = false;
              setStatus(false, "Not connected", { disconnectedByUser: state.disconnectedByUser });
            });
          });
        }

        setStatus(lastStatus.connected, lastStatus.detail, {
          connecting: lastStatus.connecting || state.connecting,
          disconnectedByUser: state.disconnectedByUser,
        });
      },
      unmount: () => {
        ui.statusText = null;
        ui.statusDot = null;
        ui.connectBtn = null;
        ui.appInfoText = null;
        ui.autoConnectInput = null;
      },
    });
  }

  return { registerConnectionTab };
}
