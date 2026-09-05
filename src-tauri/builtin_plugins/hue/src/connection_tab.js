import { ui, setStatus, lastStatus } from "./protocol.js";

/** connection tab workflow. */
export function createConnectionTab({
  applyProfileSettings,
  cancelPairing,
  closePairPanel,
  ctx,
  discoverBridges,
  ensurePairPanel,
  iconDataUrl,
  persistProfilePatch,
  renderBridgeInputMode,
  renderBridgeList,
  renderDiscoveryState,
  renderPairActionButton,
  renderPairedUiState,
  setBridgeInputMode,
  startPairing,
  state,
  unpairBridge,
}) {
  function registerConnectionTab() {
    ctx.connections?.registerTab?.({
      id: "hue",
      name: "Philips Hue",
      icon_data: iconDataUrl || null,
      order: 30,
      mount: (container) => {
        container.innerHTML = `
        <div class="connection-item-header">
          <div class="connection-info">
            <img src="${iconDataUrl || ""}" alt="Philips Hue" class="connection-icon" />
            <span class="connection-name">Philips Hue</span>
          </div>
          <div class="connection-status">
            <span class="connection-status-dot" data-role="dot"></span>
            <span data-role="text">Not connected</span>
          </div>
        </div>
        <div class="connection-content-wrapper" style="flex-direction:column;gap:12px;">
          <div data-role="bridge-setup-section" class="hue-setup-card" style="padding:10px 12px;">
            <div class="connection-row" data-role="mode-tabs-row" style="margin:0 0 10px 0;">
              <div class="hue-tab-strip">
                <button type="button" class="hue-mode-btn" data-role="mode-discovery">Bridge Discovery</button>
                <button type="button" class="hue-mode-btn" data-role="mode-manual">Manual IP</button>
              </div>
            </div>
            <div class="connection-row" data-role="discovery-section" style="margin-top:0;">
              <div class="hue-discovery-heading">
                <label style="margin:0;">Discovered Bridges</label>
              </div>
              <div class="hue-discovery-field-row">
                <div data-role="bridge-list" class="plugins-manager-list" style="max-height:130px;overflow:auto;"></div>
                <button type="button" class="hue-refresh-btn" data-role="refresh">Refresh</button>
              </div>
              <div data-role="discovery-state" class="plugins-store-status" style="margin-top:6px;"></div>
            </div>
            <div class="connection-row" data-role="manual-ip-row" style="display:none;margin-top:0;">
              <label>Manual Bridge IP</label>
              <input data-role="bridge-ip" type="text" placeholder="192.168.1.20" style="max-width:320px;" />
            </div>
          </div>
          <div data-role="paired-summary" class="hue-setup-card hue-paired-summary" style="display:none;padding:10px 12px;">
            <div class="hue-summary-heading">Bridge Setup</div>
            <div data-role="paired-summary-text" class="hue-summary-text">Paired with bridge.</div>
          </div>
        </div>
        <div class="hue-actions" style="display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:8px;align-items:center;margin-top:10px;">
          <button type="button" class="connection-button" data-role="pair-action" style="min-width:0;width:100%;margin-top:0;padding:10px 12px;">Start pairing</button>
          <div class="connection-row checkbox-row" style="justify-content:flex-end;margin-top:0;">
            <input type="checkbox" data-role="auto" id="hue-auto-connect" />
            <label for="hue-auto-connect">Auto connect</label>
          </div>
        </div>
      `;

        ui.statusText = container.querySelector('[data-role="text"]');
        ui.statusDot = container.querySelector('[data-role="dot"]');
        ui.autoConnectInput = container.querySelector('[data-role="auto"]');
        ui.bridgeIpInput = container.querySelector('[data-role="bridge-ip"]');
        ui.bridgeSetupSection = container.querySelector('[data-role="bridge-setup-section"]');
        ui.manualIpRow = container.querySelector('[data-role="manual-ip-row"]');
        ui.modeTabsRow = container.querySelector('[data-role="mode-tabs-row"]');
        ui.modeDiscoveryBtn = container.querySelector('[data-role="mode-discovery"]');
        ui.modeManualBtn = container.querySelector('[data-role="mode-manual"]');
        ui.bridgeList = container.querySelector('[data-role="bridge-list"]');
        ui.discoveryState = container.querySelector('[data-role="discovery-state"]');
        ui.discoverySection = container.querySelector('[data-role="discovery-section"]');
        ui.refreshBtn = container.querySelector('[data-role="refresh"]');
        ui.pairedSummarySection = container.querySelector('[data-role="paired-summary"]');
        ui.pairedSummaryText = container.querySelector('[data-role="paired-summary-text"]');
        ui.pairActionBtn = container.querySelector('[data-role="pair-action"]');
        ui.invalidateBindingsUI = ctx.app?.invalidateBindingsUI;

        applyProfileSettings(ctx.profile?.get?.());

        const pairPanel = ensurePairPanel();
        if (!pairPanel.dataset.bound) {
          pairPanel.querySelector('[data-role="cancel"]')?.addEventListener("click", cancelPairing);
          pairPanel.querySelector('[data-role="close"]')?.addEventListener("click", cancelPairing);
          pairPanel.addEventListener("click", (event) => {
            if (event.target === pairPanel) cancelPairing();
          });
          pairPanel.dataset.bound = "1";
        }

        if (ui.bridgeIpInput) {
          ui.bridgeIpInput.addEventListener("change", async () => {
            const next = String(ui.bridgeIpInput.value || "").trim();
            state.selectedBridgeIp = next;
            await persistProfilePatch({ bridge_ip: next });
            renderBridgeList();
          });
        }

        ui.modeDiscoveryBtn?.addEventListener("click", () => setBridgeInputMode("discovery"));
        ui.modeManualBtn?.addEventListener("click", () => setBridgeInputMode("manual"));

        if (ui.autoConnectInput) {
          ui.autoConnectInput.addEventListener("change", async () => {
            const next = Boolean(ui.autoConnectInput.checked);
            await persistProfilePatch({ auto_connect: next });
          });
        }

        if (ui.refreshBtn) {
          ui.refreshBtn.addEventListener("click", async () => {
            await discoverBridges();
          });
        }

        if (ui.pairActionBtn) {
          ui.pairActionBtn.addEventListener("click", async () => {
            if (state.username) {
              await unpairBridge();
              return;
            }
            await startPairing();
          });
        }

        renderPairActionButton();
        renderPairedUiState();
        renderDiscoveryState();
        renderBridgeList();
        renderBridgeInputMode();

        if (!state.hasAutoDiscovered) {
          state.hasAutoDiscovered = true;
          discoverBridges({ silent: true }).catch(() => {});
        }

        setStatus(lastStatus.connected, lastStatus.detail, {
          connecting: lastStatus.connecting,
          disconnectedByUser: state.disconnectedByUser,
        });
      },
      unmount: () => {
        ui.statusText = null;
        ui.statusDot = null;
        ui.autoConnectInput = null;
        ui.bridgeIpInput = null;
        ui.bridgeSetupSection = null;
        ui.manualIpRow = null;
        ui.modeTabsRow = null;
        ui.modeDiscoveryBtn = null;
        ui.modeManualBtn = null;
        ui.bridgeList = null;
        ui.discoveryState = null;
        ui.discoverySection = null;
        ui.refreshBtn = null;
        ui.pairedSummarySection = null;
        ui.pairedSummaryText = null;
        ui.pairActionBtn = null;
        closePairPanel();
      },
    });
  }

  return { registerConnectionTab };
}
