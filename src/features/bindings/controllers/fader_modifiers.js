import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../../ui/dropdown_select.js";
import {
  ensureFaderModifiers,
  modifierField,
} from "../../../core/fader_modifiers.js";
import { muteIconSvg, bindingActionIconSvg } from "../icons.js";
import { assignModeTooltip, muteBehaviorTooltip } from "../shape_helpers.js";

export function createFaderModifiers({
  elements,
  editorState,
  getConfigBinding,
  lifetime,
  startAuxLearn,
  t,
  renderMidiMappingSummary,
}) {
  let selectedId = null;
  let bindingId = null;
  let draggedId = null;
  const dropdowns = new Map();

  function disposeModifiers() {
    for (const entry of dropdowns.values()) {
      window.removeEventListener("resize", entry.root.__positionDropdownMenu);
      window.removeEventListener(
        "scroll",
        entry.root.__positionDropdownMenu,
        true,
      );
    }
    dropdowns.clear();
  }

  function renderModeDropdown(entry, mode) {
    renderNativeSelectDropdown({
      entry,
      selectEl: mode,
      truncateDisplayLabel: false,
    });
    entry.button.title = mode.title;
    entry.button.setAttribute("aria-label", mode.getAttribute("aria-label"));
  }

  const locked = () =>
    Boolean(editorState.learnField || editorState.transferPrompt);
  const label = (kind) =>
    t(
      kind === "Mute"
        ? "bindings.mute"
        : kind === "Solo"
          ? "bindings.solo"
          : "common.assign",
    );
  const modeTooltip = (kind, value) =>
    kind === "Assign"
      ? assignModeTooltip(value)
      : kind === "Solo"
        ? t(
            value === "SetFromValue"
              ? "bindings.soloMatchTooltip"
              : "bindings.soloToggleTooltip",
          )
        : muteBehaviorTooltip(value);

  function remove(id) {
    const binding = getConfigBinding();
    if (!binding || locked()) return;
    binding.modifiers = ensureFaderModifiers(binding).filter(
      (modifier) => modifier.id !== id,
    );
    editorState.acceptedTransfers.delete(modifierField(id));
    selectedId = null;
    renderModifiers(binding);
  }

  function discardUnmappedModifiers() {
    const binding = getConfigBinding();
    if (!binding || !Array.isArray(binding.modifiers)) return;
    binding.modifiers = binding.modifiers.filter((modifier) => {
      if (modifier.control?.device_id?.trim()) return true;
      editorState.acceptedTransfers.delete(modifierField(modifier.id));
      if (selectedId === modifier.id) selectedId = null;
      return false;
    });
    renderModifiers(binding);
  }

  function renderModifiers(binding) {
    const list = elements.bindingConfigModifiersList;
    if (!list) return;
    if (bindingId !== binding.id) {
      selectedId = null;
      bindingId = binding.id;
    }
    const scrollTop = list.scrollTop;
    disposeModifiers();
    list.replaceChildren();
    const modifiers = ensureFaderModifiers(binding).filter(
      (modifier) => modifier.control?.device_id?.trim(),
    );
    for (const modifier of modifiers) {
      const row = document.createElement("div");
      row.className = "binding-config-modifier-row";
      row.dataset.modifierId = modifier.id;
      row.classList.toggle("is-selected", selectedId === modifier.id);
      const grip = document.createElement("button");
      grip.type = "button";
      grip.className = "binding-config-modifier-grip";
      grip.draggable = true;
      grip.setAttribute("aria-label", t("bindings.reorderModifier"));
      grip.title = t("bindings.reorderModifier");
      grip.innerHTML = '<span class="drag-grip" aria-hidden="true"></span>';
      const icon = document.createElement("span");
      icon.className = `binding-config-modifier-icon binding-config-modifier-icon--${modifier.kind.toLowerCase()}`;
      icon.innerHTML =
        modifier.kind === "Mute"
          ? muteIconSvg(false)
          : bindingActionIconSvg(modifier.kind === "Solo" ? "solo" : "assign");
      icon.setAttribute("aria-hidden", "true");
      const copy = document.createElement("div");
      copy.className = "binding-config-modifier-copy";
      const title = document.createElement("strong");
      title.textContent = label(modifier.kind);
      const mapping = document.createElement("span");
      mapping.className = "binding-config-modifier-mapping";
      {
        const control = modifier.control;
        const type =
          control.msg_type === "Note"
            ? "Note"
            : control.msg_type === "PitchBend"
              ? "PB"
              : control.msg_type === "ProgramChange"
                ? "Program"
                : "CC";
        renderMidiMappingSummary(
          mapping,
          control.device_id,
          control,
          `Ch ${control.channel} ${type} ${control.controller}`,
        );
      }
      copy.append(title, mapping);
      const mode = document.createElement("select");
      mode.className = "binding-config-modifier-mode";
      mode.dataset.modifierMode = modifier.id;
      mode.setAttribute(
        "aria-label",
        `${label(modifier.kind)} ${t("bindings.modifierMode")}`,
      );
      const modes =
        modifier.kind === "Assign"
          ? [
              ["Add", "common.add"],
              ["Replace", "bindings.replace"],
              ["Clear", "common.clear"],
            ]
          : [
              ["ToggleOnPress", "bindings.toggle"],
              ["SetFromValue", "common.match"],
            ];
      for (const [value, key] of modes) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = t(key);
        mode.appendChild(option);
      }
      mode.value =
        modifier.kind === "Assign"
          ? modifier.assign_mode || "Add"
          : modifier.control?.mute_behavior ||
            modifier.mute_behavior ||
            "ToggleOnPress";
      mode.title = modeTooltip(modifier.kind, mode.value);
      const learn = document.createElement("button");
      learn.type = "button";
      learn.className =
        "binding-config-button binding-config-button--primary binding-config-icon-button";
      learn.dataset.modifierLearn = modifierField(modifier.id);
      learn.innerHTML = elements.bindingConfigFeedbackLearn?.innerHTML || "";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className =
        "binding-config-button binding-config-button--secondary binding-config-icon-button";
      clear.dataset.modifierRemove = modifier.id;
      clear.title = t("bindings.removeModifier");
      clear.setAttribute(
        "aria-label",
        `${t("bindings.removeModifier")}: ${label(modifier.kind)}`,
      );
      clear.innerHTML = bindingActionIconSvg("remove");
      row.append(grip, icon, copy, mode, learn, clear);
      list.appendChild(row);
      const entry = createSelectDropdownShell({
        selectEl: mode,
        rootClass: "binding-config-modifier-dropdown settings-select-dropdown",
        title: mode.title,
      });
      dropdowns.set(modifier.id, entry);
      renderModeDropdown(entry, mode);
    }
    if (!modifiers.length) {
      const empty = document.createElement("p");
      empty.className = "binding-config-modifiers-empty";
      empty.textContent = t("bindings.noModifiers");
      list.appendChild(empty);
    }
    list.scrollTop = scrollTop;
    updateModifierLearnUi();
  }

  function updateModifierLearnUi() {
    const list = elements.bindingConfigModifiersList;
    if (!list) return;
    for (const button of list.querySelectorAll("[data-modifier-learn]")) {
      const active = editorState.learnField === button.dataset.modifierLearn;
      const text = t(active ? "bindings.listening" : "common.learn");
      button.title = text;
      button.setAttribute("aria-label", text);
      button.classList.toggle("is-learning", active);
      button.disabled = Boolean(
        editorState.transferPrompt || (editorState.learnField && !active),
      );
    }
    for (const control of list.querySelectorAll(
      "select, [data-modifier-remove], .binding-config-modifier-grip",
    ))
      control.disabled = locked();
    for (const entry of dropdowns.values()) entry.button.disabled = locked();
    if (elements.bindingConfigModifierAdd)
      elements.bindingConfigModifierAdd.disabled = locked();
    if (elements.bindingConfigModifierRemove)
      elements.bindingConfigModifierRemove.disabled = locked() || !selectedId;
  }

  function bindModifiersUi() {
    lifetime.listen(elements.bindingConfigModifierAdd, "click", () => {
      const menu = elements.bindingConfigModifierMenu;
      const open = menu.classList.toggle("hidden") === false;
      elements.bindingConfigModifierAdd.setAttribute(
        "aria-expanded",
        String(open),
      );
    });
    lifetime.listen(elements.bindingConfigModifierMenu, "click", async (event) => {
      const kind = event.target.closest("[data-modifier-kind]")?.dataset
        .modifierKind;
      const binding = getConfigBinding();
      if (!kind || !binding || locked()) return;
      const modifier = {
        id: crypto.randomUUID(),
        kind,
        control: null,
        assign_mode: "Add",
        mute_behavior: "ToggleOnPress",
      };
      ensureFaderModifiers(binding).push(modifier);
      selectedId = modifier.id;
      elements.bindingConfigModifierMenu.classList.add("hidden");
      elements.bindingConfigModifierAdd.setAttribute("aria-expanded", "false");
      renderModifiers(binding);
      await startAuxLearn(modifierField(modifier.id));
    });
    lifetime.listen(elements.bindingConfigModifierRemove, "click", () =>
      remove(selectedId),
    );
    lifetime.listen(elements.bindingConfigModifiersList, "click", (event) => {
      const row = event.target.closest("[data-modifier-id]");
      if (!row || locked()) return;
      selectedId = row.dataset.modifierId;
      for (const item of elements.bindingConfigModifiersList.children)
        item.classList.toggle("is-selected", item === row);
      const learn = event.target.closest("[data-modifier-learn]");
      const clear = event.target.closest("[data-modifier-remove]");
      if (learn)
        startAuxLearn(learn.dataset.modifierLearn).catch(console.error);
      else if (clear) remove(clear.dataset.modifierRemove);
      updateModifierLearnUi();
    });
    lifetime.listen(elements.bindingConfigModifiersList, "change", (event) => {
      const id = event.target.dataset.modifierMode;
      const binding = getConfigBinding();
      if (!id || !binding || locked()) return;
      const modifier = binding.modifiers.find((item) => item.id === id);
      if (modifier.kind === "Assign") modifier.assign_mode = event.target.value;
      else {
        modifier.mute_behavior = event.target.value;
        if (modifier.control)
          modifier.control.mute_behavior = event.target.value;
      }
      event.target.title = modeTooltip(modifier.kind, event.target.value);
      renderModeDropdown(dropdowns.get(id), event.target);
    });
    lifetime.listen(
      elements.bindingConfigModifiersList,
      "dragstart",
      (event) => {
        if (locked()) {
          event.preventDefault();
          return;
        }
        draggedId =
          event.target.closest("[data-modifier-id]")?.dataset.modifierId;
        if (draggedId) {
          event.dataTransfer.setData("text/plain", draggedId);
          event.dataTransfer.effectAllowed = "move";
        }
      },
    );
    lifetime.listen(
      elements.bindingConfigModifiersList,
      "dragover",
      (event) => {
        if (draggedId) event.preventDefault();
      },
    );
    lifetime.listen(elements.bindingConfigModifiersList, "drop", (event) => {
      event.preventDefault();
      const binding = getConfigBinding();
      const targetId =
        event.target.closest("[data-modifier-id]")?.dataset.modifierId;
      if (!binding || !draggedId || !targetId || locked()) return;
      const from = binding.modifiers.findIndex((item) => item.id === draggedId);
      const to = binding.modifiers.findIndex((item) => item.id === targetId);
      if (from >= 0 && to >= 0)
        binding.modifiers.splice(to, 0, binding.modifiers.splice(from, 1)[0]);
      draggedId = null;
      renderModifiers(binding);
    });
    lifetime.listen(elements.bindingConfigModifiersList, "dragend", () => {
      draggedId = null;
    });
    lifetime.listen(elements.bindingConfigModifiersList, "keydown", (event) => {
      if (
        !event.altKey ||
        !["ArrowUp", "ArrowDown"].includes(event.key) ||
        locked()
      )
        return;
      const binding = getConfigBinding();
      const id = event.target.closest("[data-modifier-id]")?.dataset.modifierId;
      if (!binding || !id) return;
      const from = binding.modifiers.findIndex((item) => item.id === id);
      const to = from + (event.key === "ArrowUp" ? -1 : 1);
      if (from < 0 || to < 0 || to >= binding.modifiers.length) return;
      event.preventDefault();
      binding.modifiers.splice(to, 0, binding.modifiers.splice(from, 1)[0]);
      renderModifiers(binding);
      Array.from(elements.bindingConfigModifiersList.children)
        .find((row) => row.dataset.modifierId === id)
        ?.querySelector("button")
        ?.focus();
    });
    lifetime.listen(document, "pointerdown", (event) => {
      if (
        elements.bindingConfigModifierAdd?.parentElement?.contains(event.target)
      )
        return;
      elements.bindingConfigModifierMenu?.classList.add("hidden");
      elements.bindingConfigModifierAdd?.setAttribute("aria-expanded", "false");
    });
  }

  return {
    renderModifiers,
    bindModifiersUi,
    updateModifierLearnUi,
    disposeModifiers,
    discardUnmappedModifiers,
  };
}
