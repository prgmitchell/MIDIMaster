export function normalizeProfileMidiPreference(source) {
  const current = (source && typeof source === "object") ? source : {};
  const routes = normalizeProfileMidiRoutes(current);
  const first = routes[0] || {};
  const configured = Boolean(
    current.configured
    ?? current.midiDevicePreferenceSet
    ?? current.midi_device_preference_set
    ?? current.midi_device_preference_configured
    ?? (routes.length > 0)
  );
  return {
    inputDeviceId: String(first.inputDeviceId || current.inputDeviceId || current.input_device_id || "").trim(),
    outputDeviceId: String(first.outputDeviceId || current.outputDeviceId || current.output_device_id || "").trim(),
    inputDeviceName: String(first.inputDeviceName || current.inputDeviceName || current.input_device_name || "").trim(),
    outputDeviceName: String(first.outputDeviceName || current.outputDeviceName || current.output_device_name || "").trim(),
    routes,
    configured,
  };
}

export function hasProfileMidiPreference(source) {
  const pref = normalizeProfileMidiPreference(source);
  return pref.configured || pref.routes.length > 0;
}

export function normalizeProfileMidiRoute(source) {
  const current = (source && typeof source === "object") ? source : {};
  const inputDeviceId = String(current.inputDeviceId || current.input_device_id || "").trim();
  const outputDeviceId = String(current.outputDeviceId || current.output_device_id || "").trim();
  if (!inputDeviceId || !outputDeviceId) return null;
  return {
    inputDeviceId,
    outputDeviceId,
    inputDeviceName: String(current.inputDeviceName || current.input_device_name || "").trim(),
    outputDeviceName: String(current.outputDeviceName || current.output_device_name || "").trim(),
    enabled: current.enabled !== false,
  };
}

export function normalizeProfileMidiRoutes(source) {
  const current = (source && typeof source === "object") ? source : {};
  const rawRoutes = Array.isArray(current.routes)
    ? current.routes
    : (Array.isArray(current.midi_device_routes) ? current.midi_device_routes : []);
  const routes = [];
  rawRoutes.forEach((raw) => {
    const route = normalizeProfileMidiRoute(raw);
    if (!route || routes.some((existing) => sameProfileInputRouteIdentity(existing, route))) return;
    routes.push(route);
  });

  if (routes.length === 0) {
    const legacy = normalizeProfileMidiRoute({
      inputDeviceId: current.inputDeviceId || current.input_device_id,
      outputDeviceId: current.outputDeviceId || current.output_device_id,
      inputDeviceName: current.inputDeviceName || current.input_device_name,
      outputDeviceName: current.outputDeviceName || current.output_device_name,
      enabled: true,
    });
    if (legacy) routes.push(legacy);
  }
  return routes;
}

function sameProfileInputRouteIdentity(left, right) {
  const leftInputId = String(left?.inputDeviceId || left?.input_device_id || "").trim();
  const rightInputId = String(right?.inputDeviceId || right?.input_device_id || "").trim();
  if (!leftInputId || leftInputId !== rightInputId) return false;

  const leftName = stripUnavailableSuffix(left?.inputDeviceName || left?.input_device_name || "");
  const rightName = stripUnavailableSuffix(right?.inputDeviceName || right?.input_device_name || "");
  return !(leftName && rightName && leftName !== rightName);
}

function stripUnavailableSuffix(label) {
  const raw = String(label || "").trim();
  return raw.endsWith(" (Unavailable)") ? raw.slice(0, -" (Unavailable)".length) : raw;
}

export function buildPersistedProfileMidiPreference(source) {
  const pref = normalizeProfileMidiPreference(source);
  const routes = pref.routes.map((route) => ({
    input_device_id: route.inputDeviceId,
    output_device_id: route.outputDeviceId,
    input_device_name: route.inputDeviceName || null,
    output_device_name: route.outputDeviceName || null,
    enabled: route.enabled !== false,
  }));
  const first = routes[0] || {};
  return {
    input_device_id: first.input_device_id || null,
    output_device_id: first.output_device_id || null,
    input_device_name: first.input_device_name || null,
    output_device_name: first.output_device_name || null,
    routes,
  };
}

export function createPreferencesRuntime({ invoke, applyTheme, keys }) {
  const storageKeys = {
    theme: keys?.theme || "uiTheme",
    midiInputId: keys?.midiInputId || "midiDeviceId",
    midiOutputId: keys?.midiOutputId || "midiOutputDeviceId",
    midiInputName: keys?.midiInputName || "midiDeviceName",
    midiOutputName: keys?.midiOutputName || "midiOutputDeviceName",
    activeProfile: keys?.activeProfile || "activeProfileName",
  };

  const persisted = {
    midiInputId: "",
    midiOutputId: "",
    midiInputName: "",
    midiOutputName: "",
    midiRoutes: [],
    activeProfileName: "",
  };

  function loadStoredTheme() {
    try {
      const stored = localStorage.getItem(storageKeys.theme);
      if (stored === "light" || stored === "dark") {
        return stored;
      }
    } catch {
      // ignore storage failures
    }
    return "light";
  }

  async function toggleTheme() {
    const nextTheme = document.body.classList.contains("dark-mode") ? "light" : "dark";
    applyTheme(nextTheme);
    try {
      localStorage.setItem(storageKeys.theme, nextTheme);
    } catch {
      // ignore storage failures
    }
    invoke("set_theme_preference", { theme: nextTheme }).catch(() => { });
  }

  function getSavedMidiDeviceIds() {
    let inputId = "";
    let outputId = "";
    let inputName = "";
    let outputName = "";
    try {
      inputId = localStorage.getItem(storageKeys.midiInputId) || "";
      outputId = localStorage.getItem(storageKeys.midiOutputId) || "";
      inputName = localStorage.getItem(storageKeys.midiInputName) || "";
      outputName = localStorage.getItem(storageKeys.midiOutputName) || "";
    } catch {
      // ignore storage failures
    }

    return {
      inputId: inputId || persisted.midiInputId || "",
      outputId: outputId || persisted.midiOutputId || "",
      inputName: inputName || persisted.midiInputName || "",
      outputName: outputName || persisted.midiOutputName || "",
      routes: persisted.midiRoutes || [],
    };
  }

  async function saveMidiDeviceIds(inputId, outputId, inputName = "", outputName = "") {
    void inputId;
    void outputId;
    void inputName;
    void outputName;
  }

  async function saveMidiDeviceRoutes(routes = []) {
    void routes;
  }

  async function clearSavedMidiDeviceIds() {
  }

  async function hydrateClientPreferences() {
    try {
      const settings = await invoke("get_app_settings");
      if (!settings || typeof settings !== "object") {
        return;
      }

      const savedTheme = settings.ui_theme ?? settings.uiTheme;
      if (savedTheme === "light" || savedTheme === "dark") {
        applyTheme(savedTheme);
        try {
          localStorage.setItem(storageKeys.theme, savedTheme);
        } catch {
          // ignore storage failures
        }
      }

      const savedInputId = settings.midi_input_device_id ?? settings.midiInputDeviceId ?? "";
      const savedOutputId = settings.midi_output_device_id ?? settings.midiOutputDeviceId ?? "";
      const savedInputName = settings.midi_input_device_name ?? settings.midiInputDeviceName ?? "";
      const savedOutputName = settings.midi_output_device_name ?? settings.midiOutputDeviceName ?? "";
      persisted.midiInputId = savedInputId || "";
      persisted.midiOutputId = savedOutputId || "";
      persisted.midiInputName = savedInputName || "";
      persisted.midiOutputName = savedOutputName || "";
      persisted.midiRoutes = normalizeProfileMidiRoutes(settings);
      const savedActiveProfileName = settings.active_profile_name ?? settings.activeProfileName ?? "";
      persisted.activeProfileName = String(savedActiveProfileName || "").trim();

      try {
        if (persisted.midiInputId && !localStorage.getItem(storageKeys.midiInputId)) {
          localStorage.setItem(storageKeys.midiInputId, persisted.midiInputId);
        }
        if (persisted.midiOutputId && !localStorage.getItem(storageKeys.midiOutputId)) {
          localStorage.setItem(storageKeys.midiOutputId, persisted.midiOutputId);
        }
        if (persisted.midiInputName && !localStorage.getItem(storageKeys.midiInputName)) {
          localStorage.setItem(storageKeys.midiInputName, persisted.midiInputName);
        }
        if (persisted.midiOutputName && !localStorage.getItem(storageKeys.midiOutputName)) {
          localStorage.setItem(storageKeys.midiOutputName, persisted.midiOutputName);
        }
        if (persisted.activeProfileName) {
          localStorage.setItem(storageKeys.activeProfile, persisted.activeProfileName);
        }
      } catch {
        // ignore storage failures
      }
    } catch {
      // ignore preference hydration failures
    }
  }

  return {
    loadStoredTheme,
    toggleTheme,
    getSavedMidiDeviceIds,
    saveMidiDeviceIds,
    saveMidiDeviceRoutes,
    clearSavedMidiDeviceIds,
    hydrateClientPreferences,
    getPersistedActiveProfileName: () => persisted.activeProfileName,
  };
}
