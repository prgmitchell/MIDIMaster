import { closeOpenDropdowns } from "../../ui/dropdown_badges.js";
import { createSelectDropdownShell, renderNativeSelectDropdown } from "../../ui/dropdown_select.js";

/** dropdowns workflow. */
export function createDropdowns({
  lifetime,
  elements,
  getOsdSettings,
  monitorView,
  settingsSelectDropdowns,
  syncAppearanceControls,
  syncOsdSettingsUi,
  t,
  viewState,
}) {
  function closeMonitorDropdown() {
    if (!monitorView.monitorDropdownEl) return;
    closeOpenDropdowns({ except: null });
  }

  function ensureSettingsSelectDropdown(selectEl, { title = "Select" } = {}) {
    if (!selectEl) return null;

    const existing = settingsSelectDropdowns.get(selectEl);
    if (existing && existing.root?.isConnected) return existing;

    const entry = createSelectDropdownShell({
      selectEl,
      rootClass: "settings-select-dropdown",
      title,
    });
    if (!entry) return null;
    settingsSelectDropdowns.set(selectEl, entry);

    if (!viewState.settingsDocClickBound) {
      viewState.settingsDocClickBound = true;
      lifetime.listen(document, "click", (event) => {
        const clickedInsideMonitor = Boolean(
          monitorView.monitorDropdownEl && monitorView.monitorDropdownEl.contains(event.target),
        );
        if (clickedInsideMonitor) return;
        const clickedInsideAnySettingsDropdown = Array.from(settingsSelectDropdowns.values()).some(
          (item) => item.root && item.root.contains(event.target),
        );
        if (clickedInsideAnySettingsDropdown) return;
        closeOpenDropdowns({ except: null });
      });
    }

    return entry;
  }

  function renderSettingsSelectDropdown(selectEl) {
    if (!selectEl) return;
    const entry = ensureSettingsSelectDropdown(selectEl, {
      title: selectEl.title || selectEl.id || t("common.select"),
    });
    if (!entry) return;
    selectEl.classList.add("hidden");
    selectEl.parentElement?.classList.add("has-custom-select");
    entry.button.disabled = Boolean(selectEl.disabled);
    entry.root.classList.toggle("is-disabled", Boolean(selectEl.disabled));
    renderNativeSelectDropdown({
      entry,
      selectEl,
      fallbackText: t("common.select"),
      closeDropdowns: () => closeOpenDropdowns({ except: null }),
      formatOptionText: (opt) => opt.textContent || "",
      getOptionBadges: () => [],
      truncateMenuLabels: false,
      truncateDisplayLabel: true,
    });
  }

  function renderAllSettingsSelectDropdowns() {
    if (elements.languageSelect) {
      renderSettingsSelectDropdown(elements.languageSelect);
    }
    if (elements.osdLabelModeSelect) {
      renderSettingsSelectDropdown(elements.osdLabelModeSelect);
    }
    if (elements.virtualAudioInputDevice) {
      renderSettingsSelectDropdown(elements.virtualAudioInputDevice);
    }
  }

  function scheduleSettingsControlSync() {
    requestAnimationFrame(() => {
      renderAllSettingsSelectDropdowns();
      syncOsdAppearanceControls();
      syncAppearanceControls();
    });
  }

  function syncOsdAppearanceControls() {
    const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
    syncOsdSettingsUi(current);
  }

  return {
    closeMonitorDropdown,
    renderSettingsSelectDropdown,
    renderAllSettingsSelectDropdowns,
    scheduleSettingsControlSync,
    syncOsdAppearanceControls,
  };
}
