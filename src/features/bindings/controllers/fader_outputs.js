import {
  createSelectDropdownShell,
  renderNativeSelectDropdown,
} from "../../ui/dropdown_select.js";
import {
  createFaderOutput,
  getOutputOrder,
  outputField,
  outputForField,
} from "../../../core/fader_outputs.js";
import {
  controlsEqual,
  primaryControlMapping,
} from "../../../core/control_mapping.js";
import { getFaderModifiers } from "../../../core/fader_modifiers.js";
import { renderLedModeDropdown } from "./led_feedback_editor.js";

const icon = (paths) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const icons = {
  Feedback: icon('<path d="M20 7H8l4-4M8 7l4 4M4 17h12l-4-4m4 4-4 4"/>'),
  Led: icon(
    '<path d="M9 18h6m-6 3h6M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z"/>',
  ),
  remove: icon('<path d="m6 6 12 12M18 6 6 18"/>'),
  lock: icon(
    '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  ),
};

export function createFaderOutputs({
  elements,
  editorState,
  getConfigBinding,
  lifetime,
  startAuxLearn,
  syncFeedbackOutputUi,
  labelForMidiDevice,
  listState,
  t,
}) {
  let selectedId = null,
    bindingId = null,
    drag = null;
  const rows = new Map();
  const locked = () =>
    Boolean(editorState.learnField || editorState.transferPrompt);
  const label = (kind) =>
    t(kind === "Led" ? "bindings.ledOutput" : "bindings.feedbackOutput");
  const number = (value, max) =>
    Math.min(max, Math.max(0, Math.trunc(Number(value) || 0)));
  const option = (text, value) => {
    const element = document.createElement("option");
    element.textContent = text;
    element.value = value;
    return element;
  };
  const defaults = (binding) => [
    {
      id: "default-feedback",
      kind: "Feedback",
      control: binding.indicator_control || primaryControlMapping(binding),
      enabled: binding.feedback_enabled !== false,
      permanent: true,
    },
    {
      id: "default-led",
      kind: "Led",
      control: binding.led_enabled
        ? binding.led_control
        : binding.indicator_control || primaryControlMapping(binding),
      enabled: true,
      feedback_mode: binding.feedback_mode || "FollowValue",
      permanent: true,
    },
  ];
  const outputs = (binding) => [
    ...defaults(binding),
    ...(binding.additional_outputs || []),
  ];

  function cancelDrag() {
    const previous = drag;
    drag = null;
    if (!previous) return;
    rows.get(previous.id)?.row.classList.remove("is-dragging");
    if (previous.grip.hasPointerCapture?.(previous.pointerId))
      previous.grip.releasePointerCapture(previous.pointerId);
  }

  function disposeOutputs() {
    cancelDrag();
    // Keep the permanent controls and their event handlers when rebuilding rows.
    const ledHome = elements.bindingConfigOutputLedSettings;
    if (ledHome && listState.feedbackModeDropdown) {
      ledHome
        .querySelector(".binding-config-led-heading")
        .append(
          elements.bindingConfigFeedbackMode,
          listState.feedbackModeDropdown.root,
        );
    }
    if (
      elements.bindingConfigFeedbackLearn &&
      elements.bindingConfigFeedbackOutputCustom
    ) {
      elements.bindingConfigFeedbackOutputCustom
        .querySelector(".binding-config-indicator-actions")
        .prepend(elements.bindingConfigFeedbackLearn);
      elements.bindingConfigFeedbackOutputCustom
        .querySelector(".binding-config-indicator-actions")
        .append(elements.bindingConfigFeedbackClear);
    }
    for (const [id, { row, dropdowns, fields }] of rows) {
      if (id === "default-feedback" || id === "default-led") {
        const home =
          id === "default-feedback"
            ? elements.bindingConfigFeedbackOutputCustom
            : ledHome.querySelector(".binding-config-led-fields");
        home.append(...fields.children);
      }
      for (const entry of dropdowns.values()) {
        window.removeEventListener("resize", entry.root.__positionDropdownMenu);
        window.removeEventListener(
          "scroll",
          entry.root.__positionDropdownMenu,
          true,
        );
      }
      row.remove();
    }
    rows.clear();
  }

  function syncRow(output, binding) {
    const entry = rows.get(output.id);
    if (!entry) return;
    const { row, type, channel, control, mode, dropdowns, fields, summary } =
      entry;
    const mapping = output.control;
    if (output.permanent) {
      fields.title =
        output.kind === "Led"
          ? elements.bindingConfigLedHelp?.textContent ||
            t("bindings.ledOutputHelp")
          : t("bindings.feedbackOutputHelp");
    }
    if (type) {
      const meter = mapping.msg_type === "ChannelPressure",
        pitch = mapping.msg_type === "PitchBend";
      type.value = output.enabled === false ? "Disabled" : mapping.msg_type;
      channel.value = String(mapping.channel + 1);
      channel.disabled = locked() || !output.enabled || meter;
      control.type = pitch ? "text" : "number";
      control.min = meter ? "1" : "0";
      control.max = meter ? "8" : "127";
      control.value = pitch
        ? "N/A"
        : String(mapping.controller + (meter ? 1 : 0));
      control.disabled = locked() || !output.enabled || pitch;
      control.previousElementSibling.textContent = t(
        meter ? "bindings.ledMeterStrip" : "bindings.indicatorControl",
      );
      const values = [
        ...(binding.feedback_enabled !== false
          ? [binding.indicator_control || primaryControlMapping(binding)]
          : []),
        ...(binding.additional_outputs || [])
          .filter((item) => item.kind === "Feedback" && item.enabled)
          .map((item) => item.control),
        ...getFaderModifiers(binding).map((modifier) => modifier.control),
      ];
      const conflict =
        output.kind === "Led" &&
        output.enabled &&
        values.some((other) => controlsEqual(mapping, other));
      fields.title = t(
        conflict
          ? "bindings.ledOutputConflict"
          : output.kind === "Led"
            ? "bindings.ledOutputHelp"
            : "bindings.feedbackOutputHelp",
      );
      control.setAttribute("aria-invalid", String(conflict));
    }
    if (mode) {
      mode.value = output.feedback_mode;
      mode.disabled = locked();
    }
    const device = summary.querySelector(".binding-config-midi-device"),
      address = summary.querySelector(".binding-config-midi-control");
    device.textContent =
      labelForMidiDevice(mapping?.device_id || binding.device_id) ||
      mapping?.device_id ||
      binding.device_id;
    address.textContent = !output.enabled
      ? t("bindings.feedbackDisabled")
      : output.permanent && output.kind === "Led" && !binding.led_enabled
        ? t("bindings.ledExistingFeedback")
        : !mapping
          ? t("bindings.ledAutomatic")
          : mapping.msg_type === "ChannelPressure"
            ? `${t("bindings.ledMeterStrip")} ${mapping.controller + 1}`
            : `Ch ${mapping.channel} ${mapping.msg_type === "PitchBend" ? "Pitch Bend" : mapping.msg_type === "Note" ? "Note" : "CC"}${mapping.msg_type === "PitchBend" ? "" : ` ${mapping.controller}`}`;
    summary.title = `${device.textContent} — ${address.textContent}`;
    row.classList.toggle("is-selected", output.id === selectedId);
    for (const [select, dropdown] of dropdowns) {
      select.disabled = locked();
      dropdown.button.disabled = select.disabled;
      if (select === mode) renderLedModeDropdown(dropdown, select, t);
      else renderNativeSelectDropdown({ entry: dropdown, selectEl: select });
    }
    if (mode && output.permanent)
      renderLedModeDropdown(listState.feedbackModeDropdown, mode, t);
    const active =
      editorState.learnField ===
      (output.id === "default-feedback"
        ? "indicator_control"
        : output.id === "default-led"
          ? "led_control"
          : outputField(output.id));
    entry.learn.disabled = Boolean(
      editorState.transferPrompt || (editorState.learnField && !active),
    );
    entry.learn.classList.toggle("is-learning", active);
    entry.learn.title = t(active ? "bindings.listening" : "common.learn");
    entry.grip.disabled = locked();
    entry.remove.disabled = locked() || output.permanent;
  }

  function createFields(output) {
    const fields = document.createElement("div");
    fields.className = "binding-config-output-fields";
    if (output.permanent) {
      if (output.kind === "Led")
        fields.classList.add("binding-config-led-fields");
      const controls =
        output.kind === "Led"
          ? [
              elements.bindingConfigLedMsgType,
              elements.bindingConfigLedChannel,
              elements.bindingConfigLedController,
            ]
          : [
              elements.bindingConfigFeedbackMsgType,
              elements.bindingConfigFeedbackChannel,
              elements.bindingConfigFeedbackController,
            ];
      fields.append(...controls.map((control) => control.closest("label")));
      return { fields };
    }
    fields.innerHTML = `
      <label class="binding-config-indicator-field"><span></span><select class="binding-config-light-select" data-output-type></select></label>
      <label class="binding-config-indicator-field"><span></span><input type="number" min="1" max="16" step="1" data-output-channel /></label>
      <label class="binding-config-indicator-field"><span></span><input type="number" min="0" max="127" step="1" data-output-control /></label>`;
    const type = fields.querySelector("select"),
      channel = fields.querySelector("[data-output-channel]"),
      control = fields.querySelector("[data-output-control]");
    for (const [value, text] of [
      ["Disabled", t("bindings.feedbackDisabled")],
      ["Note", "Note"],
      ["ControlChange", "CC"],
      output.kind === "Led"
        ? ["ChannelPressure", t("bindings.ledMackieMeter")]
        : ["PitchBend", t("bindings.pitchBend")],
    ])
      type.appendChild(option(text, value));
    for (const [field, key] of [
      [type, "bindings.indicatorType"],
      [channel, "bindings.indicatorChannel"],
      [control, "bindings.indicatorControl"],
    ]) {
      field.previousElementSibling.textContent = t(key);
      field.setAttribute("aria-label", t(key));
    }
    return {
      fields,
      type,
      channel,
      control,
    };
  }

  function createRow(output) {
    const row = document.createElement("div");
    row.className = "binding-config-modifier-row binding-config-output-row";
    row.dataset.outputId = output.id;
    row.innerHTML = `<button type="button" class="binding-config-modifier-grip" data-output-grip><span class="drag-grip" aria-hidden="true"></span></button>
      <span class="binding-config-modifier-icon binding-config-output-icon" aria-hidden="true"></span>
      <div class="binding-config-modifier-copy"><strong></strong><span class="binding-config-modifier-mapping binding-config-midi-stack"><span class="binding-config-midi-device"></span><span class="binding-config-midi-control"></span></span></div>
      <div data-output-fields></div>
      <div class="binding-config-output-mode"></div>
      <button type="button" class="binding-config-button binding-config-button--primary binding-config-icon-button" data-output-learn></button>
      <button type="button" class="binding-config-button binding-config-button--secondary binding-config-icon-button" data-output-remove></button>`;
    row.querySelector("strong").textContent = label(output.kind);
    row.querySelector(".binding-config-output-icon").innerHTML =
      icons[output.kind];
    const grip = row.querySelector("[data-output-grip]"),
      remove = row.querySelector("[data-output-remove]");
    grip.title = t("bindings.reorderOutput");
    grip.setAttribute("aria-label", grip.title);
    remove.innerHTML = output.permanent ? icons.lock : icons.remove;
    remove.title = t(
      output.permanent ? "bindings.defaultOutput" : "bindings.removeOutput",
    );
    remove.setAttribute("aria-label", remove.title);
    let learn = row.querySelector("[data-output-learn]");
    learn.innerHTML = elements.bindingConfigFeedbackLearn?.innerHTML || "";
    learn.setAttribute("aria-label", t("common.learn"));
    if (output.id === "default-feedback") {
      learn.replaceWith(elements.bindingConfigFeedbackLearn);
      learn = elements.bindingConfigFeedbackLearn;
    }
    const dropdowns = new Map();
    let mode = null;
    if (output.kind === "Led") {
      const root = row.querySelector(".binding-config-output-mode");
      if (output.permanent) {
        mode = elements.bindingConfigFeedbackMode;
        root.append(mode, listState.feedbackModeDropdown.root);
      } else {
        mode = document.createElement("select");
        mode.className = "binding-config-light-select";
        mode.dataset.outputMode = "true";
        mode.setAttribute("aria-label", t("bindings.feedbackMode"));
        mode.append(
          option(t("bindings.followValue"), "FollowValue"),
          option(t("bindings.audioReactive"), "AudioReactive"),
        );
        root.appendChild(mode);
        dropdowns.set(
          mode,
          createSelectDropdownShell({
            selectEl: mode,
            rootClass: "binding-config-light-dropdown settings-select-dropdown",
            title: mode.getAttribute("aria-label"),
            preferUp: true,
          }),
        );
      }
    } else if (output.permanent) {
      row
        .querySelector(".binding-config-output-mode")
        .append(elements.bindingConfigFeedbackClear);
    }
    const fields = createFields(output);
    row.querySelector("[data-output-fields]").replaceWith(fields.fields);
    if (fields.type)
      dropdowns.set(
        fields.type,
        createSelectDropdownShell({
          selectEl: fields.type,
          rootClass: "binding-config-light-dropdown settings-select-dropdown",
          title: t("bindings.indicatorType"),
          preferUp: true,
        }),
      );
    rows.set(output.id, {
      row,
      ...fields,
      mode,
      dropdowns,
      remove,
      grip,
      learn,
      summary: row.querySelector(".binding-config-modifier-mapping"),
    });
    return row;
  }

  function renderOutputs(binding) {
    if (!elements.bindingConfigOutputsList) return;
    if (bindingId !== binding.id) {
      bindingId = binding.id;
      selectedId = null;
    }
    const scroll = elements.bindingConfigOutputsList.scrollTop;
    disposeOutputs();
    const items = outputs(binding);
    for (const id of getOutputOrder(binding)) {
      const output = items.find((item) => item.id === id);
      elements.bindingConfigOutputsList.appendChild(createRow(output));
      syncRow(output, binding);
    }
    elements.bindingConfigOutputsList.scrollTop = scroll;
    updateOutputLearnUi();
  }

  function updateOutputLearnUi() {
    const binding = getConfigBinding();
    if (!binding) return;
    for (const output of outputs(binding)) syncRow(output, binding);
    if (elements.bindingConfigOutputAdd)
      elements.bindingConfigOutputAdd.disabled = locked();
    if (elements.bindingConfigOutputRemove)
      elements.bindingConfigOutputRemove.disabled =
        locked() ||
        !binding.additional_outputs?.some((output) => output.id === selectedId);
  }

  function removeOutput(id) {
    const binding = getConfigBinding();
    if (
      !binding ||
      locked() ||
      !binding.additional_outputs?.some((output) => output.id === id)
    )
      return;
    binding.additional_outputs = binding.additional_outputs.filter(
      (output) => output.id !== id,
    );
    binding.output_order = getOutputOrder(binding);
    editorState.acceptedTransfers.delete(outputField(id));
    selectedId = null;
    renderOutputs(binding);
    syncFeedbackOutputUi(binding);
  }

  function update(event) {
    if (locked()) return;
    const row = event.target.closest("[data-output-id]");
    const binding = getConfigBinding(),
      output = outputForField(binding, outputField(row?.dataset.outputId));
    if (output && event.target.matches("select, input")) {
      const entry = rows.get(output.id),
        oldType = output.control.msg_type;
      output.enabled = entry.type.value !== "Disabled";
      if (output.enabled) output.control.msg_type = entry.type.value;
      const meter = output.control.msg_type === "ChannelPressure";
      output.control.channel = meter
        ? 0
        : number(Number(entry.channel.value) - 1, 15);
      output.control.controller =
        output.control.msg_type === "PitchBend"
          ? 0
          : meter
            ? oldType !== "ChannelPressure"
              ? number(binding.control.channel, 7)
              : number(Number(entry.control.value) - 1, 7)
            : number(entry.control.value, 127);
      if (entry.mode) output.feedback_mode = entry.mode.value;
      syncFeedbackOutputUi(binding);
    }
    updateOutputLearnUi();
  }

  function moveOutput(fromId, toId) {
    const binding = getConfigBinding();
    if (!binding || locked()) return;
    const order = getOutputOrder(binding),
      from = order.indexOf(fromId),
      to = order.indexOf(toId);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    binding.output_order = order;
    binding.additional_outputs?.sort(
      (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
    );
    renderOutputs(binding);
  }

  function bindOutputsUi() {
    lifetime.listen(elements.bindingConfigOutputAdd, "click", () => {
      const open = !elements.bindingConfigOutputMenu.classList.toggle("hidden");
      elements.bindingConfigOutputAdd.setAttribute(
        "aria-expanded",
        String(open),
      );
    });
    lifetime.listen(elements.bindingConfigOutputMenu, "click", (event) => {
      const kind =
          event.target.closest("[data-output-kind]")?.dataset.outputKind,
        binding = getConfigBinding();
      if (!kind || !binding || locked()) return;
      const output = createFaderOutput(binding, kind);
      if (!output) return;
      (binding.additional_outputs ||= []).push(output);
      selectedId = output.id;
      elements.bindingConfigOutputMenu.classList.add("hidden");
      elements.bindingConfigOutputAdd.setAttribute("aria-expanded", "false");
      renderOutputs(binding);
      rows.get(output.id)?.row.scrollIntoView({ block: "nearest" });
    });
    lifetime.listen(elements.bindingConfigOutputRemove, "click", () =>
      removeOutput(selectedId),
    );
    lifetime.listen(elements.bindingConfigOutputsList, "click", (event) => {
      const row = event.target.closest("[data-output-id]");
      if (!row || locked()) return;
      selectedId = row.dataset.outputId;
      if (event.target.closest("[data-output-remove]"))
        removeOutput(selectedId);
      else if (event.target.closest("[data-output-learn]")) {
        startAuxLearn(
          selectedId === "default-led"
            ? "led_control"
            : outputField(selectedId),
        ).catch(console.error);
      }
      updateOutputLearnUi();
    });
    lifetime.listen(elements.bindingConfigOutputsList, "change", update);
    lifetime.listen(elements.bindingConfigOutputsList, "input", update);
    lifetime.listen(
      elements.bindingConfigOutputsList,
      "pointerdown",
      (event) => {
        const grip = event.target.closest("[data-output-grip]");
        if (!grip || locked() || event.button !== 0) return;
        event.preventDefault();
        cancelDrag();
        const row = grip.closest("[data-output-id]");
        drag = {
          id: row.dataset.outputId,
          grip,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
        row.classList.add("is-dragging");
        grip.setPointerCapture?.(event.pointerId);
      },
    );
    lifetime.listen(document, "pointerup", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const previous = drag;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-output-id]");
      cancelDrag();
      if (
        target &&
        elements.bindingConfigOutputsList.contains(target) &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) >= 6
      )
        moveOutput(previous.id, target.dataset.outputId);
    });
    lifetime.listen(document, "pointercancel", cancelDrag);
    lifetime.listen(window, "blur", cancelDrag);
    lifetime.listen(elements.bindingConfigOutputsList, "keydown", (event) => {
      if (
        !event.altKey ||
        !["ArrowUp", "ArrowDown"].includes(event.key) ||
        locked()
      )
        return;
      const id = event.target.closest("[data-output-id]")?.dataset.outputId,
        order = getOutputOrder(getConfigBinding());
      const index = order.indexOf(id),
        target = order[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (index < 0 || !target) return;
      event.preventDefault();
      moveOutput(id, target);
      rows.get(id)?.grip.focus();
    });
    lifetime.listen(document, "pointerdown", (event) => {
      if (
        !elements.bindingConfigOutputAdd?.parentElement.contains(event.target)
      ) {
        elements.bindingConfigOutputMenu?.classList.add("hidden");
        elements.bindingConfigOutputAdd?.setAttribute("aria-expanded", "false");
      }
    });
  }
  return { renderOutputs, bindOutputsUi, updateOutputLearnUi, disposeOutputs };
}
