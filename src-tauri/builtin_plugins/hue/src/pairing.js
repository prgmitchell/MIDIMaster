import { setStatus, ui, PAIR_WINDOW_MS, hueErrorFromResult, sleep } from "./protocol.js";

/** pairing workflow. */
export function createPairing({
  closePairPanel,
  effectiveBridgeIp,
  invokeWithTimeout,
  openPairPanel,
  persistProfilePatch,
  refreshHueState,
  renderBridgeList,
  renderDiscoveryState,
  renderPairActionButton,
  renderPairedUiState,
  setPairPanelMessage,
  state,
  writeScheduler,
}) {
  function markDisconnected(detail = "Disconnected") {
    if (state.disposed) return;
    state.connected = false;
    state.connecting = false;
    state.transientWriteFailures = 0;
    writeScheduler.clear();
    if (state.postWriteRefreshTimer) {
      clearTimeout(state.postWriteRefreshTimer);
      state.postWriteRefreshTimer = null;
    }
    setStatus(false, detail, { disconnectedByUser: state.disconnectedByUser });
  }

  async function connectOnce() {
    if (state.disposed) return false;
    if (state.connecting) return false;

    const ip = effectiveBridgeIp();
    if (!ip) {
      markDisconnected("Set bridge IP first");
      return false;
    }
    if (!state.username) {
      markDisconnected("Start pairing first");
      return false;
    }

    state.connecting = true;
    setStatus(false, "Connecting...", { connecting: true, disconnectedByUser: state.disconnectedByUser });

    try {
      if (state.bridgeIp !== ip) {
        state.bridgeIp = ip;
        await persistProfilePatch({ bridge_ip: ip });
      }
      await refreshHueState({ silent: true });
      if (state.disposed) return false;
      state.connected = true;
      state.connecting = false;
      state.transientWriteFailures = 0;
      state.manualConnectRequested = false;
      state.disconnectedByUser = false;
      setStatus(true, `Connected (${ip})`);
      return true;
    } catch {
      if (state.disposed) return false;
      state.connected = false;
      state.connecting = false;
      setStatus(false, "Not connected", { disconnectedByUser: state.disconnectedByUser });
      return false;
    }
  }

  async function discoverBridges(opts = null) {
    if (state.disposed) return;
    const silent = opts && typeof opts === "object" ? Boolean(opts.silent) : false;
    if (state.discovering) return;
    state.discovering = true;
    renderDiscoveryState();
    renderBridgeList();

    try {
      const candidateIps = Array.from(
        new Set(
          [
            String(state.selectedBridgeIp || "").trim(),
            String(state.bridgeIp || "").trim(),
            String(ui.bridgeIpInput?.value || "").trim(),
          ].filter(Boolean),
        ),
      );
      const ips = await invokeWithTimeout(
        "hue_discover_bridges",
        {
          candidateIps,
          candidate_ips: candidateIps,
        },
        12000,
      );
      if (state.disposed) return;
      const unique = Array.from(
        new Set((Array.isArray(ips) ? ips : []).map((x) => String(x || "").trim()).filter(Boolean)),
      );
      state.discoveredBridges = unique;
      console.debug("[hue] discovery", {
        cloudResultCount: unique.length,
        candidateIps,
      });

      const current = effectiveBridgeIp();
      if (current && unique.includes(current)) {
        state.selectedBridgeIp = current;
      } else if (!current && unique.length > 0) {
        state.selectedBridgeIp = unique[0];
        if (ui.bridgeIpInput) ui.bridgeIpInput.value = state.selectedBridgeIp;
      }

      if (!silent) {
        const detail = state.connected
          ? `Connected (${effectiveBridgeIp()})`
          : unique.length > 0
            ? "Bridge scan complete"
            : "No bridges found";
        setStatus(state.connected, detail, { disconnectedByUser: state.disconnectedByUser });
      }
    } catch (err) {
      if (state.disposed) return;
      state.discoveredBridges = [];
      console.debug("[hue] discovery failed", {
        error: err?.message || String(err || ""),
        candidateIps: [
          String(state.selectedBridgeIp || "").trim(),
          String(state.bridgeIp || "").trim(),
          String(ui.bridgeIpInput?.value || "").trim(),
        ].filter(Boolean),
      });
      if (!silent) {
        setStatus(
          state.connected,
          state.connected ? `Connected (${effectiveBridgeIp()})` : "Bridge scan failed",
          { disconnectedByUser: state.disconnectedByUser },
        );
      }
    } finally {
      state.discovering = false;
      if (state.disposed) return;
      renderDiscoveryState();
      renderBridgeList();
    }
  }

  async function pairBridge(token) {
    const ip = effectiveBridgeIp();
    if (!ip) {
      throw new Error("Set bridge IP first");
    }

    const started = Date.now();
    let lastErr = null;

    while (Date.now() - started < PAIR_WINDOW_MS) {
      if (token?.cancelled) {
        throw new Error("__PAIR_CANCELLED__");
      }

      try {
        const json = await invokeWithTimeout(
          "hue_pair_bridge",
          {
            bridgeIp: ip,
            devicetype: "midimaster#desktop",
            bridge_ip: ip,
          },
          3500,
        );

        if (Array.isArray(json)) {
          const success = json.find((item) => item && item.success && item.success.username);
          if (success?.success?.username) {
            return String(success.success.username);
          }
          const err = hueErrorFromResult(json);
          if (err?.type === "101") {
            lastErr = "Press the bridge button to pair...";
            setPairPanelMessage(lastErr);
          } else if (err) {
            throw new Error(err.description);
          }
        }
      } catch (err) {
        const msg = err?.message || "Pairing failed";
        if (msg === "__PAIR_CANCELLED__") throw err;
        lastErr = msg;
      }

      await sleep(1000);
    }

    throw new Error(lastErr || "Pairing timed out");
  }

  async function startPairing() {
    if (state.disposed) return;
    if (state.pairing) return;

    const ip = effectiveBridgeIp();
    if (!ip) {
      setStatus(false, "Set bridge IP first", { disconnectedByUser: state.disconnectedByUser });
      return;
    }

    state.pairing = true;
    state.pairingCancelToken = { cancelled: false };
    renderPairActionButton();
    openPairPanel("Press the physical button on your Hue Bridge.");
    setStatus(false, "Waiting for bridge button...", {
      connecting: true,
      disconnectedByUser: state.disconnectedByUser,
    });

    try {
      state.bridgeIp = ip;
      state.selectedBridgeIp = ip;
      await persistProfilePatch({ bridge_ip: ip });
      const pairedUsername = await pairBridge(state.pairingCancelToken);
      state.bridgeIp = ip;
      await persistProfilePatch({ bridge_ip: ip, username: pairedUsername });
      setPairPanelMessage("Pairing complete.");
      setStatus(false, "Bridge paired", { disconnectedByUser: state.disconnectedByUser });
      state.disconnectedByUser = false;
      state.manualConnectRequested = true;
      await connectOnce();
      closePairPanel();
    } catch (err) {
      const msg = err?.message || "Pairing failed";
      if (msg === "__PAIR_CANCELLED__") {
        setStatus(false, "Pairing cancelled", { disconnectedByUser: state.disconnectedByUser });
      } else {
        setPairPanelMessage(msg);
        setStatus(false, msg, { disconnectedByUser: state.disconnectedByUser });
      }
      closePairPanel();
    } finally {
      state.pairing = false;
      state.pairingCancelToken = null;
      renderPairActionButton();
      renderPairedUiState();
    }
  }

  async function unpairBridge() {
    if (state.pairing) return;
    state.disconnectedByUser = true;
    state.manualConnectRequested = false;
    markDisconnected("Unpaired");
    await persistProfilePatch({ username: "" });
    renderPairActionButton();
    renderPairedUiState();
  }

  function cancelPairing() {
    if (!state.pairingCancelToken) return;
    state.pairingCancelToken.cancelled = true;
    closePairPanel();
  }

  return { markDisconnected, connectOnce, discoverBridges, startPairing, unpairBridge, cancelPairing };
}
