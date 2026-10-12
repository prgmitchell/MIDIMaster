export function createConnectionTab({ ctx, state, runtime, icon }) {
  let root = null;
  const read = (role) => root?.querySelector(`[data-role="${role}"]`);

  function render() {
    if (!root) return;
    root.innerHTML = `
      <div class="connection-item-header">
        <div class="connection-info">
          <img src="${icon || ""}" alt="FxSound" class="connection-icon" />
          <span class="connection-name">FxSound</span>
        </div>
        <div class="connection-status">
          <span class="connection-status-dot" data-role="dot"></span>
          <span data-role="status"></span>
        </div>
      </div>
      <div class="connection-content-wrapper">
        <div class="connection-description">
          <p>Control FxSound EQ, effects, processing, and presets through your MIDI bindings.</p>
          <p>Ensure FxSound is running. Use auto connect to reconnect on startup.</p>
        </div>
      </div>
      <div class="connection-footer">
        <button type="button" class="connection-button" data-role="connect">Connect</button>
        <div class="connection-row checkbox-row">
          <input type="checkbox" data-role="auto" id="fxsound-auto-connect" />
          <label for="fxsound-auto-connect">Auto connect</label>
        </div>
      </div>`;
    read("auto").checked = state.settings.auto_connect;
    read("auto").onchange = async (event) => {
      state.settings.auto_connect = event.target.checked;
      await ctx.profile.set({ ...ctx.profile.get(), ...state.settings });
      if (state.settings.auto_connect && !state.snapshot.connected)
        await runtime.connect();
    };
    read("connect").onclick = () =>
      state.snapshot.connected ? runtime.disconnect() : runtime.connect();
    update();
  }

  function update() {
    if (!root) return;
    const { snapshot } = state;
    read("status").textContent = state.connecting
      ? "Connecting..."
      : snapshot.detail;
    read("dot").classList.toggle("connected", snapshot.connected);
    read("dot").classList.toggle("connecting", Boolean(state.connecting));
    read("connect").textContent = state.connecting
      ? "Connecting..."
      : snapshot.connected
        ? "Disconnect"
        : "Connect";
    read("connect").disabled = Boolean(state.connecting);
    read("connect").classList.toggle("disabled", Boolean(state.connecting));
    read("connect").classList.toggle(
      "danger",
      snapshot.connected && !state.connecting,
    );
    read("auto").checked = state.settings.auto_connect;
  }

  ctx.connections.registerTab({
    id: "fxsound",
    name: "FxSound",
    icon_data: icon,
    order: 36,
    mount: (container) => {
      root = container;
      render();
    },
    unmount: () => {
      root = null;
    },
  });
  return { update, render };
}
