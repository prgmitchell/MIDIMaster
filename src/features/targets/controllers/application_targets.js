import {
  normalizeOpenApplicationMapping,
  normalizeAutoHotkeyScriptMapping,
} from "../../../core/binding_model.js";

/** application targets workflow. */
export function createApplicationTargets({ callInvoke, getSess }) {
  function normalizeOpenApplication(raw) {
    const normalized = normalizeOpenApplicationMapping(raw);
    if (!normalized) return null;
    return {
      ...normalized,
      display: friendlyAppName(normalized.display) || normalized.display,
    };
  }

  function normalizeAutoHotkeyScript(raw) {
    const normalized = normalizeAutoHotkeyScriptMapping(raw);
    if (!normalized) return null;
    return {
      ...normalized,
      display: displayNameFromPath(normalized.display) || normalized.display,
    };
  }

  function displayNameFromPath(path) {
    const value = String(path || "").trim();
    if (!value) return "";
    const parts = value.split(/[\\/]/);
    return parts[parts.length - 1] || value;
  }

  function friendlyAppName(rawNameOrPath) {
    const base = displayNameFromPath(rawNameOrPath);
    if (!base) return "";
    return base.replace(/\.exe$/i, "").trim() || base;
  }

  function normalizeCompareName(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/\.exe$/i, "")
      .replace(/[^a-z0-9]+/g, "");
  }

  function resolveOpenApplicationIcon(openApplication) {
    if (!openApplication?.display && !openApplication?.path) return null;
    const needle = normalizeCompareName(openApplication.display || openApplication.path);
    if (!needle) return null;
    const sessions = getSess();
    if (!Array.isArray(sessions) || sessions.length === 0) return null;
    for (const session of sessions) {
      const icon = session?.icon_data || null;
      if (!icon) continue;
      const candidates = [
        session?.display_name,
        session?.name,
        session?.process_name,
        session?.process,
        session?.exe,
      ];
      const matched = candidates.some((candidate) => normalizeCompareName(candidate) === needle);
      if (matched) return icon;
    }
    return null;
  }

  function exeNameFromPath(path) {
    const filename = String(path || "")
      .split(/[\\/]/)
      .pop()
      .trim();
    return filename || "";
  }

  function processTagForSession(session) {
    const processName = exeNameFromPath(session?.process_name) || exeNameFromPath(session?.process_path);
    if (!processName || /^pid\s+\d+$/i.test(processName) || /^msedgewebview2\.exe$/i.test(processName)) {
      return "";
    }
    return processName;
  }

  async function pickOpenApplication() {
    if (!callInvoke) return null;
    const picked = await callInvoke("pick_executable_path");
    if (!picked) return null;
    const path = String(picked.path || "").trim();
    if (!path) return null;
    const display = String(picked.display || "").trim();
    const iconData =
      typeof picked.icon_data === "string" && picked.icon_data.trim() ? picked.icon_data.trim() : null;
    return {
      path,
      display: friendlyAppName(display || path),
      icon_data: iconData,
    };
  }

  async function pickAutoHotkeyScript() {
    if (!callInvoke) return null;
    const picked = await callInvoke("pick_autohotkey_script_path");
    if (!picked) return null;
    const path = String(picked.path || "").trim();
    if (!path) return null;
    const display = String(picked.display || "").trim();
    return {
      path,
      display: displayNameFromPath(display || path) || display || path,
    };
  }

  return {
    normalizeOpenApplication,
    normalizeAutoHotkeyScript,
    displayNameFromPath,
    friendlyAppName,
    normalizeCompareName,
    resolveOpenApplicationIcon,
    exeNameFromPath,
    processTagForSession,
    pickOpenApplication,
    pickAutoHotkeyScript,
  };
}
