import {
  normalizeMidiDeviceInventorySettings,
  MIDI_DEVICE_INVENTORY_NOTICE_VERSION,
} from "../../../app/midi_device_inventory.js";

/** navigation workflow. */
export function createNavigation({
  elements,
  defaultSettingsSection,
  getAppSettings,
  syncAppearanceControls,
  syncOsdAppearanceControls,
  viewState,
  virtualAudio,
}) {
  function syncMidiDeviceInventoryToggle(settings = null) {
    if (!elements.midiDeviceInventoryConsentToggle) return;
    const current = settings || (typeof getAppSettings === "function" ? getAppSettings() || {} : {});
    const inventory = normalizeMidiDeviceInventorySettings(current);
    elements.midiDeviceInventoryConsentToggle.checked =
      inventory.consent === "enabled" && inventory.noticeVersion >= MIDI_DEVICE_INVENTORY_NOTICE_VERSION;
  }

  function closeSettingsPanel() {
    if (!elements.settingsPanel) return;
    virtualAudio.setActive(false).catch(() => {});
    elements.settingsPanel.classList.add("hidden");
  }

  function getActiveSettingsSection() {
    if (!elements.settingsPanel) return defaultSettingsSection;
    return (
      elements.settingsPanel.querySelector("[data-settings-section].active")?.dataset?.settingsSection ||
      defaultSettingsSection
    );
  }

  function openSettingsPanel() {
    if (!elements.settingsPanel) return;
    elements.settingsPanel.classList.remove("hidden");
    activateSettingsSection(getActiveSettingsSection());
    scheduleSettingsNavIndicatorSync({ animate: false });
  }

  function activateSettingsSection(sectionName) {
    if (!elements.settingsPanel) return;
    const nextSection = String(sectionName || defaultSettingsSection);
    const navItems = Array.from(elements.settingsPanel.querySelectorAll("[data-settings-section]"));
    const panels = Array.from(elements.settingsPanel.querySelectorAll("[data-settings-panel]"));
    const hasPanel = panels.some((panel) => panel.dataset.settingsPanel === nextSection);
    const activeSection = hasPanel ? nextSection : defaultSettingsSection;

    navItems.forEach((item) => {
      const active = item.dataset.settingsSection === activeSection;
      item.classList.toggle("active", active);
      if (active) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });
    panels.forEach((panel) => {
      const active = panel.dataset.settingsPanel === activeSection;
      panel.classList.toggle("active", active);
      panel.classList.toggle("hidden", !active);
    });
    virtualAudio.setActive(activeSection === "virtual-audio").catch(() => {});
    if (activeSection === "osd") {
      syncOsdAppearanceControls();
    } else if (activeSection === "appearance") {
      syncAppearanceControls();
    }
    scheduleSettingsNavIndicatorSync({ animate: true });
  }

  function syncSettingsNavIndicator({ animate = true } = {}) {
    if (!elements.settingsPanel) return;
    const sidebar = elements.settingsPanel.querySelector(".settings-sidebar");
    const indicator = sidebar?.querySelector(".settings-nav-indicator");
    const active = sidebar?.querySelector(".settings-nav-item.active");
    if (!indicator || !active || !sidebar) {
      if (indicator) indicator.style.opacity = "0";
      return;
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    indicator.classList.toggle("is-ready", Boolean(animate));
    indicator.style.width = `${activeRect.width}px`;
    indicator.style.height = `${activeRect.height}px`;
    indicator.style.transform = `translate(${activeRect.left - sidebarRect.left}px, ${activeRect.top - sidebarRect.top}px)`;
    indicator.style.opacity = "1";
    if (!animate) {
      requestAnimationFrame(() => {
        indicator.classList.add("is-ready");
      });
    }
  }

  function scheduleSettingsNavIndicatorSync({ animate = true } = {}) {
    if (viewState.settingsNavIndicatorRaf) {
      cancelAnimationFrame(viewState.settingsNavIndicatorRaf);
    }
    viewState.settingsNavIndicatorRaf = requestAnimationFrame(() => {
      viewState.settingsNavIndicatorRaf = 0;
      syncSettingsNavIndicator({ animate });
    });
  }

  return {
    syncMidiDeviceInventoryToggle,
    closeSettingsPanel,
    openSettingsPanel,
    activateSettingsSection,
    scheduleSettingsNavIndicatorSync,
  };
}
