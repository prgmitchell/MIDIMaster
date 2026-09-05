import {
  normalizeFaderCurvePresets,
  curvePresetPointsEqual,
  findMatchingFaderCurvePreset,
  nextCurvePresetName,
  normalizeCurvePresetPoints,
  normalizeCurvePresetName,
  curvePointsForBinding,
  MAX_FADER_CURVE_PRESETS,
} from "../fader_curve_presets.js";
import { normalizeFaderCurve } from "../../../core/binding_model.js";

/** curve presets workflow. */
export function createCurvePresets({
  alertAction,
  confirmAction,
  curveState,
  elements,
  getConfigBinding,
  getCurvePresets,
  renderConfigModal,
  saveCurvePresets,
  setActionIcon,
  t,
}) {
  function currentCurvePresets() {
    return normalizeFaderCurvePresets(getCurvePresets());
  }

  function activeCustomCurvePreset(binding = getConfigBinding()) {
    const presets = currentCurvePresets();
    const selected = presets.find((preset) => preset.id === curveState.selectedCustomCurvePresetId);
    if (
      selected &&
      normalizeFaderCurve(binding?.fader_curve) === "Custom" &&
      curvePresetPointsEqual(binding?.custom_curve, selected.points)
    ) {
      return selected;
    }
    return findMatchingFaderCurvePreset(binding, presets);
  }

  function setCurvePresetMenuOpen(open) {
    curveState.curvePresetMenuOpen = Boolean(open);
    if (elements.bindingConfigCurvePresetMenu) {
      elements.bindingConfigCurvePresetMenu.classList.toggle("hidden", !curveState.curvePresetMenuOpen);
    }
    if (elements.bindingConfigCurvePresetButton) {
      elements.bindingConfigCurvePresetButton.setAttribute(
        "aria-expanded",
        String(curveState.curvePresetMenuOpen),
      );
    }
    if (curveState.curvePresetMenuOpen) {
      renderCurvePresetMenu();
      requestAnimationFrame(() => elements.bindingConfigCurvePresetSearch?.focus?.({ preventScroll: true }));
    }
  }

  function closeCurvePresetMenu() {
    setCurvePresetMenuOpen(false);
  }

  function closeCurvePresetForm() {
    curveState.curvePresetFormMode = null;
    curveState.curvePresetFormPresetId = null;
    if (elements.bindingConfigCurvePresetForm) {
      elements.bindingConfigCurvePresetForm.classList.add("hidden");
    }
  }

  function openCurvePresetForm(mode, preset = null) {
    curveState.curvePresetFormMode = mode === "rename" ? "rename" : "save";
    curveState.curvePresetFormPresetId = preset?.id || null;
    if (elements.bindingConfigCurvePresetForm) {
      elements.bindingConfigCurvePresetForm.classList.remove("hidden");
      elements.bindingConfigCurvePresetForm.dataset.mode = curveState.curvePresetFormMode;
    }
    if (elements.bindingConfigCurvePresetFormTitle) {
      elements.bindingConfigCurvePresetFormTitle.textContent =
        curveState.curvePresetFormMode === "rename"
          ? t("bindings.curvePresetRenameTitle")
          : t("bindings.curvePresetSaveTitle");
    }
    if (elements.bindingConfigCurvePresetName) {
      elements.bindingConfigCurvePresetName.value =
        preset?.name || nextCurvePresetName(currentCurvePresets());
      requestAnimationFrame(() => {
        elements.bindingConfigCurvePresetName?.focus?.({ preventScroll: true });
        elements.bindingConfigCurvePresetName?.select?.();
      });
    }
    closeCurvePresetMenu();
  }

  function syncCurvePresetToolbar(binding) {
    const presets = currentCurvePresets();
    const activeCustom = activeCustomCurvePreset(binding);
    curveState.selectedCustomCurvePresetId = activeCustom?.id || null;
    if (elements.bindingConfigCurvePresetButton) {
      const label = activeCustom?.name || t("bindings.myCurves");
      elements.bindingConfigCurvePresetButton.textContent = label || t("bindings.presets");
    }
    if (elements.bindingConfigCurvePresetSave) {
      elements.bindingConfigCurvePresetSave.disabled = false;
    }
    if (elements.bindingConfigCurvePresetForm) {
      elements.bindingConfigCurvePresetForm.classList.toggle("hidden", !curveState.curvePresetFormMode);
    }
    renderCurvePresetMenu();
  }

  function appendCurvePresetGroup(container, title, items, renderItem, emptyText = "") {
    if (!container || (!items.length && !emptyText)) return;
    const group = document.createElement("div");
    group.className = "binding-config-curve-preset-group";
    const heading = document.createElement("div");
    heading.className = "binding-config-curve-preset-heading";
    heading.textContent = title;
    group.appendChild(heading);
    if (items.length) {
      items.forEach((item) => group.appendChild(renderItem(item)));
    } else {
      const empty = document.createElement("div");
      empty.className = "binding-config-curve-preset-empty";
      empty.textContent = emptyText;
      group.appendChild(empty);
    }
    container.appendChild(group);
  }

  function renderCurvePresetMenu() {
    if (!elements.bindingConfigCurvePresetList) return;
    const binding = getConfigBinding();
    const presets = currentCurvePresets();
    const query = curveState.curvePresetSearchQuery.trim().toLowerCase();
    const activeCustom = activeCustomCurvePreset(binding);
    elements.bindingConfigCurvePresetList.innerHTML = "";
    if (
      elements.bindingConfigCurvePresetSearch &&
      elements.bindingConfigCurvePresetSearch.value !== curveState.curvePresetSearchQuery
    ) {
      elements.bindingConfigCurvePresetSearch.value = curveState.curvePresetSearchQuery;
    }

    const customPresets = presets.filter((preset) => !query || preset.name.toLowerCase().includes(query));

    const renderCustom = (preset) => {
      const row = document.createElement("div");
      row.className = "binding-config-curve-preset-custom-row";
      row.classList.toggle("is-selected", activeCustom?.id === preset.id);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "binding-config-curve-preset-option";
      button.dataset.curvePresetKind = "custom";
      button.dataset.curvePresetId = preset.id;
      button.textContent = preset.name;
      button.classList.toggle("is-selected", activeCustom?.id === preset.id);
      button.addEventListener("click", () => {
        applyCurvePresetToDraft(preset);
      });
      row.appendChild(button);

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "binding-config-curve-preset-action";
      setActionIcon(editButton, "edit", t("bindings.renameCurvePreset"));
      editButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCurvePresetForm("rename", preset);
      });
      row.appendChild(editButton);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className =
        "binding-config-curve-preset-action binding-config-curve-preset-action--danger";
      setActionIcon(deleteButton, "delete", t("bindings.deleteCurvePreset"));
      deleteButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await deleteCurvePreset(preset);
      });
      row.appendChild(deleteButton);

      return row;
    };

    appendCurvePresetGroup(
      elements.bindingConfigCurvePresetList,
      t("bindings.myCurves"),
      customPresets,
      renderCustom,
      query ? t("bindings.curvePresetNoSearchResults") : t("bindings.curvePresetEmpty"),
    );
  }

  function applyCurvePresetToDraft(preset) {
    const binding = getConfigBinding();
    if (!binding || !preset) return;
    binding.fader_curve = "Custom";
    binding.custom_curve = normalizeCurvePresetPoints(preset.points);
    curveState.selectedCustomCurvePresetId = preset.id;
    closeCurvePresetForm();
    closeCurvePresetMenu();
    renderConfigModal();
  }

  async function submitCurvePresetForm() {
    const binding = getConfigBinding();
    if (!binding) return;
    const name = normalizeCurvePresetName(elements.bindingConfigCurvePresetName?.value || "");
    if (!name) {
      alertAction(t("bindings.curvePresetInvalidTitle"), t("bindings.curvePresetInvalidName"));
      return;
    }

    const presets = currentCurvePresets();
    if (curveState.curvePresetFormMode === "rename") {
      const preset =
        presets.find((item) => item.id === curveState.curvePresetFormPresetId) ||
        activeCustomCurvePreset(binding);
      if (!preset) return;
      const duplicate = presets.find(
        (item) => item.id !== preset.id && item.name.toLowerCase() === name.toLowerCase(),
      );
      if (duplicate) {
        alertAction(t("bindings.curvePresetDuplicateTitle"), t("bindings.curvePresetDuplicateName"));
        return;
      }
      const saved = await saveCurvePresets(
        presets.map((item) => (item.id === preset.id ? { ...item, name } : item)),
      );
      curveState.selectedCustomCurvePresetId =
        normalizeFaderCurvePresets(saved).find((item) => item.name.toLowerCase() === name.toLowerCase())
          ?.id || preset.id;
      closeCurvePresetForm();
      renderConfigModal();
      return;
    }

    const points = normalizeCurvePresetPoints(curvePointsForBinding(binding));
    if (points.length < 2) {
      alertAction(t("bindings.curvePresetInvalidTitle"), t("bindings.curvePresetInvalidCurve"));
      return;
    }
    const existing = presets.find((item) => item.name.toLowerCase() === name.toLowerCase());
    let nextPresets;
    if (existing) {
      const confirmed = await confirmAction({
        title: t("bindings.curvePresetReplaceTitle"),
        message: t("bindings.curvePresetReplaceMessage", { name }),
        confirmLabel: t("common.save"),
        cancelLabel: t("common.cancel"),
        overlayClass: "target-panel--over-config",
      });
      if (!confirmed) return;
      nextPresets = presets.map((item) => (item.id === existing.id ? { ...item, name, points } : item));
    } else {
      if (presets.length >= MAX_FADER_CURVE_PRESETS) {
        alertAction(
          t("bindings.curvePresetLimitTitle"),
          t("bindings.curvePresetLimitMessage", { count: MAX_FADER_CURVE_PRESETS }),
        );
        return;
      }
      nextPresets = [...presets, { id: "", name, points }];
    }
    const saved = normalizeFaderCurvePresets(await saveCurvePresets(nextPresets));
    curveState.selectedCustomCurvePresetId =
      saved.find((item) => item.name.toLowerCase() === name.toLowerCase())?.id || null;
    closeCurvePresetForm();
    renderConfigModal();
  }

  async function deleteCurvePreset(preset) {
    if (!preset) return;
    const confirmed = await confirmAction({
      title: t("bindings.curvePresetDeleteTitle"),
      message: t("bindings.curvePresetDeleteMessage", { name: preset.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      confirmVariant: "danger",
      overlayClass: "target-panel--over-config",
    });
    if (!confirmed) return;
    await saveCurvePresets(currentCurvePresets().filter((item) => item.id !== preset.id));
    if (curveState.selectedCustomCurvePresetId === preset.id) {
      curveState.selectedCustomCurvePresetId = null;
    }
    closeCurvePresetForm();
    renderConfigModal();
  }

  return {
    activeCustomCurvePreset,
    setCurvePresetMenuOpen,
    closeCurvePresetMenu,
    closeCurvePresetForm,
    openCurvePresetForm,
    syncCurvePresetToolbar,
    renderCurvePresetMenu,
    submitCurvePresetForm,
  };
}
