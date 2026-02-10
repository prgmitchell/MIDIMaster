// MIDIMaster Plugin Starter Template (API v1)
//
// Notes:
// - Keep this file self-contained (Blob-import friendly).
// - Use ctx.profile for per-profile settings.
// - Use ctx.feedback.set(...) to keep UI + OSD + motor faders in sync.

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export async function activate(ctx) {
  const iconDataUrl = await (async () => {
    try {
      return await ctx.assets.readDataUrl("icon.svg", "image/svg+xml");
    } catch {
      return null;
    }
  })();

  // Example profile setting
  const DEFAULT_AUTO_CONNECT = false;
  let settings = ctx.profile?.get?.() || {};
  let autoConnect = ("auto_connect" in settings) ? Boolean(settings.auto_connect) : DEFAULT_AUTO_CONNECT;

  // Connection state for demonstration
  let connected = false;
  let connecting = false;

  function describeConnection() {
    if (connected) return "Connected";
    if (connecting) return "Connecting...";
    return "Not connected";
  }

  function setConnected(next) {
    const changed = Boolean(next) !== connected;
    connected = Boolean(next);
    connecting = false;
    if (changed) {
      try { ctx.app?.invalidateBindingsUI?.(); } catch { }
    }
  }

  // Connections tab (optional but recommended for real integrations)
  ctx.connections?.registerTab?.({
    id: "my_plugin",
    name: "My Plugin",
    icon_data: iconDataUrl,
    order: 80,
    mount: (container) => {
      container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="" class="connection-icon" />
            <span class="connection-name">My Plugin</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot ${connected ? "connected" : ""}" data-role="dot"></span>
            <span data-role="text">${describeConnection()}</span>
          </div>
        </div>
        <div class="connection-content-wrapper">
          <div class="connection-description">
            <p>This is a starter template. Replace the fake connect logic with your integration.</p>
          </div>
        </div>
        <div class="connection-footer">
          <button type="button" class="connection-button ${connected ? "danger" : ""}" data-role="connect">${connected ? "Disconnect" : "Connect"}</button>
          <div class="connection-row checkbox-row">
            <input type="checkbox" data-role="auto" id="my-plugin-auto-connect" ${autoConnect ? "checked" : ""} />
            <label for="my-plugin-auto-connect">Auto connect</label>
          </div>
        </div>
      `;

      const dot = container.querySelector('[data-role="dot"]');
      const text = container.querySelector('[data-role="text"]');
      const btn = container.querySelector('[data-role="connect"]');
      const auto = container.querySelector('[data-role="auto"]');

      function renderStatus() {
        if (text) text.textContent = describeConnection();
        if (dot) dot.classList.toggle("connected", connected);
        if (btn) {
          btn.classList.toggle("danger", connected);
          btn.textContent = connected ? "Disconnect" : (connecting ? "Connecting..." : "Connect");
          btn.disabled = Boolean(connecting);
        }
      }

      renderStatus();

      if (auto) {
        auto.addEventListener("change", async () => {
          autoConnect = Boolean(auto.checked);
          const cur = ctx.profile?.get?.() || {};
          await ctx.profile?.set?.({ ...cur, auto_connect: autoConnect });
        });
      }

      if (btn) {
        btn.addEventListener("click", () => {
          if (connecting) return;
          if (connected) {
            setConnected(false);
            renderStatus();
            return;
          }
          connecting = true;
          renderStatus();
          setTimeout(() => {
            setConnected(true);
            renderStatus();
          }, 300);
        });
      }
    },
  });

  // Integration API
  ctx.registerIntegration({
    id: "my_plugin",
    name: "My Plugin",
    icon_data: iconDataUrl,

    describeTarget: (target) => {
      const t = target?.Integration || target?.integration;
      const data = t?.data || {};
      const label = data.label || data.name || "My Plugin Target";
      const icon_data = data.icon_data || iconDataUrl;
      return { label: String(label), icon_data, ghost: !connected };
    },

    getTargetOptions: async ({ nav, controlType } = {}) => {
      // Demonstrate a tiny nested menu.
      if (!connected) {
        return [{ label: "Connect in Connections to load targets.", kind: "placeholder", ghost: true }];
      }

      if (nav && nav.screen === "group" && nav.groupId) {
        const groupId = String(nav.groupId);
        return [
          {
            label: `Group ${groupId} - Volume`,
            icon_data: iconDataUrl,
            target: {
              Integration: {
                integration_id: "my_plugin",
                kind: "group_volume",
                data: { group_id: groupId },
              },
            },
          },
        ];
      }

      // Root list
      return [
        {
          label: controlType === "button" ? "Demo Button Target" : "Demo Fader Target",
          icon_data: iconDataUrl,
          target: {
            Integration: {
              integration_id: "my_plugin",
              kind: "demo",
              data: { name: "Demo" },
            },
          },
        },
        {
          label: "Group 1",
          icon_data: iconDataUrl,
          nav: { screen: "group", groupId: "1" },
        },
      ];
    },

    onBindingTriggered: async ({ binding_id, action, value }) => {
      // Replace this with real integration calls.
      const v = clamp01(value);

      // Echo feedback so the controller/UI reflect the new state.
      // Use silent for startup sync / reconnect sync.
      await ctx.feedback.set(binding_id, action === "ToggleMute" ? (v > 0.5 ? 1.0 : 0.0) : v, action);
    },
  });

  // Optional: simple auto-connect behavior
  if (autoConnect) {
    connecting = true;
    setTimeout(() => setConnected(true), 200);
  }
}
