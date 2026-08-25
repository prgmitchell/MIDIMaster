import {
  MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
  canSubmitMidiDeviceInventory,
  normalizeMidiDeviceInventorySettings,
  shouldPromptMidiDeviceInventoryConsent,
} from "./midi_device_inventory.js";

export function createMidiInventoryController({
  invoke,
  settingsStore,
  syncSettingsUi,
  showChoices,
  translate,
  reportError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  submitDelayMs = 900,
}) {
  let submitTimer = 0;
  let submitInFlight = false;
  let submitQueued = false;

  function applySettings(settings = {}) {
    const normalized = normalizeMidiDeviceInventorySettings(settings);
    const patch = {
      midiDeviceInventoryConsent: normalized.consent,
      midiDeviceInventoryNoticeVersion: normalized.noticeVersion,
    };
    settingsStore.update(patch);
    syncSettingsUi?.(patch);
    return normalized;
  }

  async function updateConsent(consent) {
    const updated = await invoke("update_midi_device_inventory_consent", {
      consent,
      noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
    });
    return applySettings(updated || {
      consent,
      noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
    });
  }

  async function maybePromptConsent() {
    if (!shouldPromptMidiDeviceInventoryConsent(settingsStore.get())) return;
    const choice = await showChoices({
      title: translate("privacy.midiDeviceInventoryTitle"),
      message: translate("privacy.midiDeviceInventoryMessage"),
      panelClass: "alert-panel-content--midi-consent",
      options: [
        { id: "disabled", label: translate("privacy.midiDeviceInventoryDecline"), variant: "secondary" },
        { id: "enabled", label: translate("privacy.midiDeviceInventoryAccept"), variant: "primary" },
      ],
    });
    if (choice !== "enabled" && choice !== "disabled") return;

    const normalized = await updateConsent(choice).catch((error) => {
      reportError("midi_device_inventory_consent_update_failed", error);
      return applySettings({
        consent: "disabled",
        noticeVersion: MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
      });
    });
    if (normalized.consent === "enabled") queueSubmit("consent_prompt_enabled");
  }

  function queueSubmit(reason = "unknown") {
    if (!canSubmitMidiDeviceInventory(settingsStore.get())) return;
    submitQueued = true;
    if (submitTimer) clearTimer(submitTimer);
    submitTimer = setTimer(() => {
      submitTimer = 0;
      flushSubmit(reason).catch((error) => {
        reportError("midi_device_inventory_submit_flush_failed", error);
      });
    }, submitDelayMs);
  }

  async function flushSubmit(reason = "unknown") {
    if (!submitQueued || submitInFlight) return;
    submitQueued = false;
    if (!canSubmitMidiDeviceInventory(settingsStore.get())) return;
    submitInFlight = true;
    try {
      await invoke("submit_midi_device_inventory");
    } catch (error) {
      reportError(`midi_device_inventory_submit_failed_${reason}`, error);
    } finally {
      submitInFlight = false;
      if (submitQueued) {
        flushSubmit("queued").catch((error) => {
          reportError("midi_device_inventory_submit_flush_failed", error);
        });
      }
    }
  }

  function dispose() {
    if (submitTimer) clearTimer(submitTimer);
    submitTimer = 0;
    submitQueued = false;
  }

  return { applySettings, updateConsent, maybePromptConsent, queueSubmit, flushSubmit, dispose };
}
