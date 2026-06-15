export const MIDI_DEVICE_INVENTORY_NOTICE_VERSION = 1;
export const MIDI_DEVICE_INVENTORY_PROMPT_EVERY_OPEN = false;

const VALID_CONSENT_VALUES = new Set(["unknown", "enabled", "disabled"]);

export function normalizeMidiDeviceInventoryConsent(value) {
  const normalized = String(value || "unknown").trim().toLowerCase();
  return VALID_CONSENT_VALUES.has(normalized) ? normalized : "unknown";
}

export function normalizeMidiDeviceInventoryNoticeVersion(value) {
  const version = Number(value);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : 0;
}

export function normalizeMidiDeviceInventorySettings(settings = {}) {
  return {
    consent: normalizeMidiDeviceInventoryConsent(
      settings.midi_device_inventory_consent
      ?? settings.midiDeviceInventoryConsent
      ?? settings.consent,
    ),
    noticeVersion: normalizeMidiDeviceInventoryNoticeVersion(
      settings.midi_device_inventory_notice_version
      ?? settings.midiDeviceInventoryNoticeVersion
      ?? settings.noticeVersion,
    ),
  };
}

export function shouldPromptMidiDeviceInventoryConsent(
  settings = {},
  noticeVersion = MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
) {
  if (MIDI_DEVICE_INVENTORY_PROMPT_EVERY_OPEN) {
    return true;
  }
  const normalized = normalizeMidiDeviceInventorySettings(settings);
  const currentNoticeVersion = normalizeMidiDeviceInventoryNoticeVersion(noticeVersion);
  return normalized.consent === "unknown" || normalized.noticeVersion < currentNoticeVersion;
}

export function canSubmitMidiDeviceInventory(
  settings = {},
  noticeVersion = MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
) {
  const normalized = normalizeMidiDeviceInventorySettings(settings);
  const currentNoticeVersion = normalizeMidiDeviceInventoryNoticeVersion(noticeVersion);
  return normalized.consent === "enabled" && normalized.noticeVersion >= currentNoticeVersion;
}
