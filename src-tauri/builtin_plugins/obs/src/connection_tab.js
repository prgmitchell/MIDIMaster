import { ui, setStatus } from "./protocol.js";

/** connection tab workflow. */
export function createConnectionTab({
  applyProfileSettings,
  connectOnce,
  ctx,
  iconDataUrl,
  loadObsSettingsFromStorage,
  queueDisconnectedFeedbackClear,
  saveObsSettingsToStorage,
  state,
}) {
  function registerConnectionTab() {
    ctx.connections?.registerTab?.({
      id: "obs",
      name: "OBS Studio",
      icon_data: iconDataUrl || null,
      order: 10,
      mount: (container) => {
        container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="OBS" class="connection-icon" />
            <span class="connection-name">OBS Studio</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot" data-role="dot"></span>
            <span data-role="text">Not connected</span>
          </div>
        </div>
        <div class="connection-content-wrapper">
          <div class="connection-grid">
            <div class="connection-row">
              <label>Host</label>
              <input data-role="host" type="text" placeholder="localhost" />
            </div>
            <div class="connection-row">
              <label>Password</label>
              <input data-role="password" type="password" placeholder="Optional" />
            </div>
            <div class="connection-row">
              <label>Port</label>
              <input data-role="port" type="number" value="4455" placeholder="4455" />
            </div>
          </div>
          <div class="connection-description">
            <p>Bind faders to OBS audio sources. Bind buttons to recording/stream actions, scene switching, and source visibility.</p>
          </div>
        </div>
        <div class="connection-footer">
          <button type="button" class="connection-button" data-role="connect">Connect</button>
          <div class="connection-row checkbox-row">
            <input type="checkbox" data-role="auto" id="obs-auto-connect" />
            <label for="obs-auto-connect">Auto connect</label>
          </div>
        </div>
      `;

        ui.statusText = container.querySelector('[data-role="text"]');
        ui.statusDot = container.querySelector('[data-role="dot"]');
        ui.hostInput = container.querySelector('[data-role="host"]');
        ui.portInput = container.querySelector('[data-role="port"]');
        ui.passwordInput = container.querySelector('[data-role="password"]');
        ui.connectBtn = container.querySelector('[data-role="connect"]');
        ui.autoConnectInput = container.querySelector('[data-role="auto"]');

        loadObsSettingsFromStorage();
        [ui.hostInput, ui.portInput, ui.passwordInput].forEach((el) => {
          el?.addEventListener("change", saveObsSettingsToStorage);
          el?.addEventListener("input", saveObsSettingsToStorage);
        });

        // Auto-connect (profile-scoped)
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
            if (state.connected) {
              state.disconnectedByUser = true;
              state.manualConnectRequested = false;
              try {
                state.ws?.close();
              } catch {}
              state.ws = null;
              state.connected = false;
              state.connecting = false;
              setStatus(false, "Disconnected", { disconnectedByUser: true });
              queueDisconnectedFeedbackClear().catch(() => {});
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

        // Apply current status
        setStatus(state.connected, state.connected ? "Connected" : "Not connected", {
          connecting: state.connecting,
          disconnectedByUser: state.disconnectedByUser,
        });
      },
      unmount: () => {
        ui.statusText = null;
        ui.statusDot = null;
        ui.connectBtn = null;
        ui.autoConnectInput = null;
        ui.hostInput = null;
        ui.portInput = null;
        ui.passwordInput = null;
      },
    });
  }

  return { registerConnectionTab };
}
