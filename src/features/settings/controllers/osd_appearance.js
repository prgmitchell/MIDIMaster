import { normalizeOsdAppearance } from "../../../core/osd_settings.js";

/** osd appearance workflow. */
export function createOsdAppearance({ elements, getOsdSettings, setOsdSettings, sliderFillPercent }) {
  function applyOsdAppearanceAttributes(appearance) {
    const previewCard = elements.osdPositionPicker?.querySelector(".settings-osd-preview-card");
    const previewScreen = elements.osdPositionPicker?.querySelector(".settings-osd-preview-screen");
    const roots = [
      document.body,
      elements.settingsPanel,
      elements.osdPositionPicker,
      elements.osdPositionPicker?.querySelector(".settings-osd-preview"),
    ].filter(Boolean);
    roots.forEach((root) => {
      root.dataset.osdStyle = appearance.style;
      root.style.setProperty("--osd-opacity", String(appearance.opacity));
      root.style.setProperty("--osd-scale", String(appearance.scale));
    });
    if (previewCard) {
      previewCard.style.opacity = String(appearance.opacity);
      previewCard.style.setProperty("--osd-scale", String(appearance.scale));
      const screenRect = previewScreen?.getBoundingClientRect?.();
      const cardWidth = 154;
      const cardHeight = 54;
      const hasMeasuredScreen = Boolean(screenRect && screenRect.width > 0 && screenRect.height > 0);
      const maxPreviewScale = hasMeasuredScreen
        ? Math.min(
            appearance.scale,
            Math.max(0.65, (screenRect.width / 3 - 12) / cardWidth),
            Math.max(0.65, (screenRect.height / 3 - 12) / cardHeight),
          )
        : appearance.scale;
      previewCard.style.setProperty("--osd-preview-scale", String(Math.max(0.65, maxPreviewScale)));
    }
  }

  function syncOsdAppearanceUi(settings = {}) {
    const appearance = normalizeOsdAppearance(settings);
    if (typeof setOsdSettings === "function") {
      const current = typeof getOsdSettings === "function" ? getOsdSettings() || {} : {};
      setOsdSettings({ ...current, ...(settings || {}), ...appearance });
    }
    applyOsdAppearanceAttributes(appearance);
    if (elements.osdStyleSelect) {
      elements.osdStyleSelect.value = appearance.style;
      elements.osdStyleSelect.classList.add("hidden");
      elements.osdStyleSelect.parentElement?.classList.add("has-segmented-style");
      elements.osdStyleSelect.parentElement?.querySelectorAll("[data-osd-style-option]").forEach((button) => {
        const selected = button.dataset.osdStyleOption === appearance.style;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
    }
    if (elements.osdTransparencyInput) {
      const transparency = Math.round(appearance.opacity * 100);
      elements.osdTransparencyInput.value = String(transparency);
      elements.osdTransparencyInput.style.setProperty(
        "--range-fill",
        `${sliderFillPercent(elements.osdTransparencyInput, transparency)}%`,
      );
      if (elements.osdTransparencyValue) {
        elements.osdTransparencyValue.textContent = `${transparency}%`;
      }
    }
    if (elements.osdScaleInput) {
      const scale = Math.round(appearance.scale * 100);
      elements.osdScaleInput.value = String(scale);
      elements.osdScaleInput.style.setProperty(
        "--range-fill",
        `${sliderFillPercent(elements.osdScaleInput, scale)}%`,
      );
      if (elements.osdScaleValue) {
        elements.osdScaleValue.textContent = `${scale}%`;
      }
    }
  }

  return { syncOsdAppearanceUi };
}
