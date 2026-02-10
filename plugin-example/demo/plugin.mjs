export async function activate(ctx) {
  let tabContainer = null;
  let lastTriggerText = "No triggers yet";

  const iconDataUrl = await (async () => {
    try {
      return await ctx.assets.readDataUrl("icon.svg", "image/svg+xml");
    } catch {
      return null;
    }
  })();

  ctx.connections.registerTab({
    id: "demo",
    name: "Demo",
    icon_data: iconDataUrl,
    order: 90,
    mount: (container) => {
      tabContainer = container;
      container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="" class="connection-icon" />
            <span class="connection-name">Demo Plugin</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot connected"></span>
            <span>Ready</span>
          </div>
        </div>
        <div class="connection-content-wrapper">
          <div class="connection-description">
            <p>This is a third-party style plugin connection tab. It is fully owned by the plugin.</p>
            <p><strong>Last trigger:</strong> <span data-role="last">${lastTriggerText}</span></p>
          </div>
        </div>
      `;
    },
  });

  ctx.registerIntegration({
    id: "demo",
    describeTarget: (target) => {
      const integ = target?.Integration;
      const name = integ?.data?.name || "Demo";
      return { label: `Demo: ${name}`, icon_data: null };
    },
    getTargetOptions: () => {
      return [
        {
          label: "Demo Knob",
          icon_data: null,
          target: {
            Integration: {
              integration_id: "demo",
              kind: "knob",
              data: { name: "Knob" }
            }
          }
        }
      ];
    },
    onBindingTriggered: async (payload) => {
      const { binding_id, action, value } = payload;

      lastTriggerText = `${action} = ${Number(value).toFixed(3)}`;
      if (tabContainer) {
        const el = tabContainer.querySelector('[data-role="last"]');
        if (el) el.textContent = lastTriggerText;
      }

      // Echo feedback so the controller updates and OSD shows.
      await ctx.feedback.set(binding_id, value, action);
    }
  });
}
