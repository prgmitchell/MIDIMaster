import { clamp01, displayChannelLabel, parseNumberedAliases, parsePresetLines } from "./protocol.js";

/** dashboard workflow. */
export function createDashboard({
  connect,
  ctx,
  disconnect,
  icon,
  poll,
  refreshDevices,
  state,
  updateStatusUi,
}) {
  function renderMeters() {
    if (!state.ui.meters) return;
    const meters = new Map(
      (state.meters || []).map((entry) => [`${entry.scope}:${entry.index}`, entry.level]),
    );
    const caps = state.status.capabilities || {};
    const layoutSignature = JSON.stringify([
      state.stripLabels,
      state.busLabels,
      state.inputDevices,
      state.outputDevices,
      caps.strip_count,
      caps.bus_count,
    ]);
    if (layoutSignature !== state.meterLayoutSignature) {
      const rows = [];
      for (const scope of ["strip", "bus"]) {
        const count = Number(scope === "strip" ? caps.strip_count : caps.bus_count);
        for (let index = 0; index < count; index += 1) {
          const level = clamp01(meters.get(`${scope}:${index}`) || 0);
          const device = scope === "strip" ? state.inputDevices[index] : state.outputDevices[index];
          rows.push(
            `<div class="vm-channel"><div class="vm-channel-copy"><strong>${escapeHtml(displayChannelLabel(scope, index, state))}</strong><span>${escapeHtml(device || (scope === "strip" ? "Input strip" : "Output bus"))}</span></div><div class="vm-meter"><i style="--level:${Math.round(level * 100)}%"></i></div><span class="vm-state">${scope === "strip" ? `IN ${index + 1}` : `BUS ${index + 1}`}</span></div>`,
          );
        }
      }
      state.meterLayoutSignature = layoutSignature;
      state.ui.meters.innerHTML =
        rows.join("") || `<div class="vm-empty">Connect to see channels and live levels.</div>`;
      state.meterElements = new Map(
        Array.from(state.ui.meters.querySelectorAll(".vm-meter i")).map((element, index) => {
          const stripCount = Number(caps.strip_count || 0);
          return [index < stripCount ? `strip:${index}` : `bus:${index - stripCount}`, element];
        }),
      );
    }
    for (const [key, element] of state.meterElements)
      element.style.setProperty("--level", `${Math.round(clamp01(meters.get(key) || 0) * 100)}%`);
  }

  function escapeHtml(value) {
    const node = document.createElement("span");
    node.textContent = String(value || "");
    return node.innerHTML;
  }

  async function saveDashboardSettings() {
    state.settings = {
      ...state.settings,
      auto_connect: Boolean(state.ui.auto?.checked),
      preferred_edition: state.ui.launchEdition?.value || "banana",
      macro_aliases: parseNumberedAliases(state.ui.aliases?.value),
      presets: parsePresetLines(state.ui.presets?.value),
    };
    await ctx.profile.set(state.settings);
  }

  function dashboardStyles() {
    return `<style>
      .vm-shell{display:grid;gap:10px;color:var(--text-primary)}.vm-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--control-border);border-radius:8px;background:linear-gradient(110deg,color-mix(in srgb,var(--surface-raised) 92%,#ff9e2c 8%),var(--surface-raised))}.vm-kicker{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}.vm-hero h3{margin:2px 0;font-size:17px}.vm-hero p{margin:0;color:var(--text-muted);font-size:11px}.vm-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.vm-grid{display:grid;grid-template-columns:minmax(250px,.7fr) minmax(420px,1.6fr);gap:10px}.vm-card{padding:12px;border:1px solid var(--control-border);border-radius:8px;background:var(--surface-raised)}.vm-card h4{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary)}.vm-field{display:grid;gap:4px;margin:0 0 8px}.vm-field label,.vm-help{font-size:10px;color:var(--text-muted)}.vm-field select,.vm-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--control-border);border-radius:6px;background:var(--control-bg);color:var(--text-primary);padding:7px;font:inherit}.vm-field textarea{min-height:56px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px}.vm-check{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-secondary);margin:2px 0 8px}.vm-channels{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:6px;align-content:start;overflow:visible}.vm-channel{display:grid;grid-template-columns:minmax(95px,.9fr) minmax(55px,1fr) 40px;gap:6px;align-items:center;padding:6px 7px;border:1px solid color-mix(in srgb,var(--control-border) 72%,transparent);border-radius:5px;background:color-mix(in srgb,var(--surface) 58%,transparent)}.vm-channel-copy{display:grid;min-width:0}.vm-channel-copy strong,.vm-channel-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vm-channel-copy strong{font-size:10px}.vm-channel-copy span{font-size:8px;color:var(--text-muted)}.vm-meter{height:6px;border-radius:2px;background:var(--slider-track);overflow:hidden}.vm-meter i{display:block;width:var(--level);height:100%;background:linear-gradient(90deg,#53d18b 0 72%,#ffcc4d 72% 90%,#ff6262 90%);transition:width 70ms linear}.vm-state{font-size:8px;letter-spacing:.06em;color:var(--text-muted);text-align:right}.vm-empty{padding:24px;text-align:center;color:var(--text-muted);font-size:11px}.vm-statusline{display:flex;align-items:center;gap:8px}.vm-note{padding:8px 10px;border-left:3px solid #ff9e2c;background:color-mix(in srgb,#ff9e2c 8%,var(--surface));font-size:10px;color:var(--text-secondary)}.vm-device-diagnostic{padding:7px 10px;border:1px solid var(--control-border);border-radius:6px;background:var(--surface-raised);font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--text-muted)}@media(max-width:900px){.vm-grid{grid-template-columns:1fr}.vm-hero{grid-template-columns:1fr}.vm-actions{justify-content:flex-start}}
    </style>`;
  }

  function renderDashboard() {
    if (!state.mounted || !state.ui.root) return;
    const root = state.ui.root;
    state.meterLayoutSignature = "";
    state.meterElements.clear();
    const editions = state.status.installed_editions || [];
    const preferred = editions.includes(state.settings.preferred_edition)
      ? state.settings.preferred_edition
      : editions.includes("banana")
        ? "banana"
        : editions.at(-1) || "banana";
    const aliasesText = Object.entries(state.settings.macro_aliases || {})
      .map(([index, name]) => `${Number(index) + 1}: ${name}`)
      .join("\n");
    const presetsText = (state.settings.presets || [])
      .map((entry) => `${Number(entry.slot) + 1}: ${entry.label}`)
      .join("\n");
    root.innerHTML = `${dashboardStyles()}<div class="vm-shell">
      <div class="connection-item-header"><div class="connection-info"><img class="connection-icon" src="${icon || ""}" alt=""><div><div class="connection-name">Voicemeeter</div><div class="vm-kicker">Native mixer bridge</div></div></div><div class="connection-status vm-statusline"><span class="connection-status-dot" data-role="dot"></span><span data-role="status">${escapeHtml(state.status.detail || "Not connected")}</span></div></div>
      <section class="vm-hero"><div><div class="vm-kicker">Signal desk</div><h3 data-role="edition">${escapeHtml(state.status.edition || "Voicemeeter")}</h3><p>MIDI control for strips, buses, routing, devices, MacroButtons, and presets.</p></div><div class="vm-actions"><button class="connection-button" data-role="connect">${state.status.connected ? "Disconnect" : "Connect"}</button><button class="connection-button" data-role="launch">Launch</button><button class="connection-button" data-role="show">Show</button><button class="connection-button" data-role="restart">Restart engine</button><button class="connection-button" data-role="refresh">Refresh</button></div></section>
      <div class="vm-grid"><section class="vm-card"><h4>Connection & target setup</h4><label class="vm-check"><input type="checkbox" data-role="auto" ${state.settings.auto_connect ? "checked" : ""}> Auto connect when Voicemeeter is running</label><div class="vm-field"><label>Edition used by the Launch button</label><select data-role="launch-edition">${editions.map((edition) => `<option value="${edition}" ${edition === preferred ? "selected" : ""}>${edition[0].toUpperCase()}${edition.slice(1)}</option>`).join("") || `<option value="banana">Banana</option>`}</select></div><div class="vm-field"><label>MacroButton aliases — one per line</label><textarea data-role="aliases" placeholder="1: Stream mute\n2: Push to talk">${escapeHtml(aliasesText)}</textarea></div><div class="vm-field"><label>Preset slots — one per line</label><textarea data-role="presets" placeholder="1: Streaming\n2: Headphones">${escapeHtml(presetsText)}</textarea></div><button class="connection-button" data-role="save">Save target setup</button><p class="vm-help">Aliases and preset labels are stored per MIDIMaster profile. Slot numbers are shown as 1-based here.</p></section><section class="vm-card"><h4>Live channels</h4><div class="vm-channels" data-role="meters"></div></section></div>
      <div class="vm-note">Changing a hardware device can interrupt audio. Auto connect never launches Voicemeeter; use Launch explicitly.</div><div class="vm-device-diagnostic" data-role="device-diagnostic" ${state.lastDeviceDiagnostic ? "" : "hidden"}>${escapeHtml(state.lastDeviceDiagnostic)}</div></div>`;
    state.ui = {
      root,
      status: root.querySelector('[data-role="status"]'),
      dot: root.querySelector('[data-role="dot"]'),
      edition: root.querySelector('[data-role="edition"]'),
      connect: root.querySelector('[data-role="connect"]'),
      auto: root.querySelector('[data-role="auto"]'),
      launchEdition: root.querySelector('[data-role="launch-edition"]'),
      aliases: root.querySelector('[data-role="aliases"]'),
      presets: root.querySelector('[data-role="presets"]'),
      meters: root.querySelector('[data-role="meters"]'),
      deviceDiagnostic: root.querySelector('[data-role="device-diagnostic"]'),
    };
    state.ui.connect.onclick = () =>
      state.status.connected ? disconnect({ manual: true }) : connect({ manual: true });
    root.querySelector('[data-role="launch"]').onclick = async () => {
      await saveDashboardSettings();
      await ctx.tauri.invoke("voicemeeter_launch", { edition: state.ui.launchEdition.value });
      setTimeout(() => connect({ manual: true }), 900);
    };
    root.querySelector('[data-role="show"]').onclick = () =>
      ctx.tauri.invoke("voicemeeter_safe_command", { action: "show", index: null }).catch(() => {});
    root.querySelector('[data-role="restart"]').onclick = async () => {
      const confirmed = await ctx.app.showConfirm({
        title: "Restart Voicemeeter audio engine?",
        message: "Audio will be interrupted briefly while Voicemeeter restarts its audio engine.",
        confirmLabel: "Restart engine",
        cancelLabel: "Cancel",
        confirmVariant: "danger",
      });
      if (confirmed) await ctx.tauri.invoke("voicemeeter_safe_command", { action: "restart", index: null });
    };
    root.querySelector('[data-role="refresh"]').onclick = async () => {
      await refreshDevices();
      await poll(true);
      renderDashboard();
    };
    root.querySelector('[data-role="save"]').onclick = async () => {
      await saveDashboardSettings();
      ctx.app.invalidateBindingsUI();
    };
    state.ui.auto.onchange = async () => {
      await saveDashboardSettings();
      if (state.settings.auto_connect) {
        state.disconnectedByUser = false;
        connect().catch(() => {});
      } else {
        state.disconnectedByUser = true;
      }
    };
    state.lastStatusUiSignature = "";
    updateStatusUi();
    renderMeters();
  }

  return { renderMeters, renderDashboard };
}
