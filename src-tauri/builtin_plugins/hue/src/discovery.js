import { ui, DEFAULT_AUTO_CONNECT } from "./protocol.js";

/** discovery workflow. */
export function createDiscovery({ ctx, resetReconnectBackoff, state }) {
  async function persistProfilePatch(patch) {
    const current = ctx.profile?.get?.() || {};
    const next = { ...current, ...patch };
    applyProfileSettings(next);
    await ctx.profile?.set?.(next);
  }

  function effectiveBridgeIp() {
    const fromSelected = String(state.selectedBridgeIp || "").trim();
    if (fromSelected) return fromSelected;
    const fromPersisted = String(state.bridgeIp || "").trim();
    if (fromPersisted) return fromPersisted;
    const fromInput = String(ui.bridgeIpInput?.value || "").trim();
    if (fromInput) return fromInput;
    return "";
  }

  function renderDiscoveryState() {
    if (!ui.discoveryState) return;
    if (state.discovering) {
      ui.discoveryState.textContent = "Discovering bridges...";
      return;
    }
    if (state.discoveredBridges.length === 0) {
      ui.discoveryState.textContent = "No bridges found. Enter an IP manually.";
      return;
    }
    ui.discoveryState.textContent = `${state.discoveredBridges.length} bridge${state.discoveredBridges.length === 1 ? "" : "s"} found`;
  }

  function renderBridgeList() {
    if (!ui.bridgeList) return;
    ui.bridgeList.innerHTML = "";

    if (state.discovering) {
      const loading = document.createElement("div");
      loading.className = "plugins-store-empty";
      loading.textContent = "Scanning local network...";
      ui.bridgeList.appendChild(loading);
      return;
    }

    if (state.discoveredBridges.length === 0) {
      const empty = document.createElement("div");
      empty.className = "plugins-store-empty";
      empty.textContent = "No bridge discovered yet.";
      ui.bridgeList.appendChild(empty);
      return;
    }

    const current = effectiveBridgeIp();

    for (const ip of state.discoveredBridges) {
      const row = document.createElement("label");
      row.className = "plugins-manager-row hue-bridge-row";
      row.style.cursor = "pointer";
      row.style.padding = "8px 10px";
      row.innerHTML = `
        <div class="plugins-manager-row-left" style="gap:8px;">
          <input type="radio" name="hue-bridge-choice" value="${ip}" ${current === ip ? "checked" : ""} />
          <div class="plugins-manager-row-text">
            <div class="plugins-manager-row-name">${ip}</div>
          </div>
        </div>
      `;
      const radio = row.querySelector('input[type="radio"]');
      radio?.addEventListener("change", async () => {
        if (!radio.checked) return;
        state.selectedBridgeIp = ip;
        if (ui.bridgeIpInput) ui.bridgeIpInput.value = ip;
        await persistProfilePatch({ bridge_ip: ip });
      });
      ui.bridgeList.appendChild(row);
    }
  }

  function renderPairActionButton() {
    if (!ui.pairActionBtn) return;

    const isPaired = Boolean(state.username);
    ui.pairActionBtn.disabled = state.pairing;
    ui.pairActionBtn.classList.remove("danger");

    if (state.pairing) {
      ui.pairActionBtn.textContent = "Pairing...";
      return;
    }

    if (isPaired) {
      ui.pairActionBtn.textContent = "Unpair";
      ui.pairActionBtn.classList.add("danger");
    } else {
      ui.pairActionBtn.textContent = "Start pairing";
    }
  }

  function renderBridgeInputMode() {
    const isPaired = Boolean(state.username);
    if (ui.bridgeSetupSection) ui.bridgeSetupSection.style.display = isPaired ? "none" : "";
    if (ui.modeTabsRow) ui.modeTabsRow.style.display = isPaired ? "none" : "";
    if (ui.discoverySection)
      ui.discoverySection.style.display = !isPaired && state.bridgeInputMode === "discovery" ? "" : "none";
    if (ui.manualIpRow)
      ui.manualIpRow.style.display = !isPaired && state.bridgeInputMode === "manual" ? "" : "none";
    if (ui.refreshBtn)
      ui.refreshBtn.style.display = !isPaired && state.bridgeInputMode === "discovery" ? "" : "none";

    if (ui.modeDiscoveryBtn)
      ui.modeDiscoveryBtn.classList.toggle("active", state.bridgeInputMode === "discovery");
    if (ui.modeManualBtn) ui.modeManualBtn.classList.toggle("active", state.bridgeInputMode === "manual");
  }

  function setBridgeInputMode(mode) {
    const next = String(mode || "").toLowerCase();
    state.bridgeInputMode = next === "manual" ? "manual" : "discovery";
    renderBridgeInputMode();
  }

  function renderPairedUiState() {
    const isPaired = Boolean(state.username);
    if (ui.bridgeIpInput) {
      ui.bridgeIpInput.disabled = isPaired;
    }
    if (ui.pairedSummarySection) {
      ui.pairedSummarySection.style.display = isPaired ? "" : "none";
    }
    if (ui.pairedSummaryText) {
      const ip = effectiveBridgeIp();
      ui.pairedSummaryText.textContent = ip ? `Paired with bridge ${ip}.` : "Paired with bridge.";
    }
    renderBridgeInputMode();
  }

  function applyProfileSettings(settings) {
    const source = settings && typeof settings === "object" ? settings : {};
    state.bridgeIp = String(source.bridge_ip || source.bridgeIp || "").trim();
    state.username = String(source.username || "").trim();
    state.autoConnect = "auto_connect" in source ? Boolean(source.auto_connect) : DEFAULT_AUTO_CONNECT;

    if (!state.selectedBridgeIp && state.bridgeIp) state.selectedBridgeIp = state.bridgeIp;

    if (!state.autoConnect) {
      state.manualConnectRequested = false;
    }

    if (ui.bridgeIpInput) ui.bridgeIpInput.value = state.bridgeIp;
    if (ui.autoConnectInput) ui.autoConnectInput.checked = state.autoConnect;

    renderPairActionButton();
    renderPairedUiState();
    renderBridgeList();
    renderDiscoveryState();
    renderBridgeInputMode();

    if (state.username && state.autoConnect && !state.connected && !state.connecting) {
      state.manualConnectRequested = true;
      state.disconnectedByUser = false;
      resetReconnectBackoff();
    }
  }

  return {
    persistProfilePatch,
    effectiveBridgeIp,
    renderDiscoveryState,
    renderBridgeList,
    renderPairActionButton,
    renderBridgeInputMode,
    setBridgeInputMode,
    renderPairedUiState,
    applyProfileSettings,
  };
}
