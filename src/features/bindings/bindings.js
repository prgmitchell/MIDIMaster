export function createBindingsFeature({
  invoke,
  dom,
  getPlaybackDevices,
  getRecordingDevices,
  getBindings,
  setBindings,
  bindingFallbackName,
  controlLabel,
  buildTargetSelect,
  getVolumeForTarget,
  getMuteForTarget,
  triggerIntegration,
  extractIntegrationTarget,
  showVolumeOsd,
  showMuteOsd,
  saveBindingsForProfile,
  getPluginHost,
  getEditingBindingId,
  setEditingBindingId,
  getPendingFocusBindingId,
  setPendingFocusBindingId,
  getDragState,
  setDragState,
  bindingInteractionTimes,
  bindingLastValues,
  bindingMuteValues,
}) {
  if (typeof invoke !== "function") {
    throw new Error("createBindingsFeature: invoke is required");
  }
  const d = (dom && typeof dom === "object") ? dom : {};
  if (!d.bindingsContainer) {
    throw new Error("createBindingsFeature: dom.bindingsContainer is required");
  }

  const getB = (typeof getBindings === "function") ? getBindings : (() => []);
  const setB = (typeof setBindings === "function") ? setBindings : (() => { });

  const getPlayback = (typeof getPlaybackDevices === "function") ? getPlaybackDevices : (() => []);
  const getRecording = (typeof getRecordingDevices === "function") ? getRecordingDevices : (() => []);

  const fallbackNameFor = (typeof bindingFallbackName === "function")
    ? bindingFallbackName
    : ((_b, i) => `Binding ${i + 1}`);
  const labelForControl = (typeof controlLabel === "function")
    ? controlLabel
    : ((c) => `Ch ${c?.channel ?? "?"} CC ${c?.controller ?? "?"}`);

  const buildTarget = (typeof buildTargetSelect === "function")
    ? buildTargetSelect
    : (() => {
      const s = document.createElement("select");
      const o = document.createElement("option");
      o.value = "Unset";
      o.textContent = "Unset";
      s.appendChild(o);
      return s;
    });

  const getVol = (typeof getVolumeForTarget === "function") ? getVolumeForTarget : (() => null);
  const getMuted = (typeof getMuteForTarget === "function") ? getMuteForTarget : (() => false);
  const trigIntegration = (typeof triggerIntegration === "function") ? triggerIntegration : (async () => false);
  const extractInteg = (typeof extractIntegrationTarget === "function") ? extractIntegrationTarget : (() => null);
  const showVolOsd = (typeof showVolumeOsd === "function") ? showVolumeOsd : (() => { });
  const showMutOsd = (typeof showMuteOsd === "function") ? showMuteOsd : (() => { });

  const saveProfile = (typeof saveBindingsForProfile === "function") ? saveBindingsForProfile : (async () => { });
  const getHost = (typeof getPluginHost === "function") ? getPluginHost : (() => null);

  const getEditingId = (typeof getEditingBindingId === "function") ? getEditingBindingId : (() => null);
  const setEditingId = (typeof setEditingBindingId === "function") ? setEditingBindingId : (() => { });
  const getPendingFocusId = (typeof getPendingFocusBindingId === "function") ? getPendingFocusBindingId : (() => null);
  const setPendingFocusId = (typeof setPendingFocusBindingId === "function") ? setPendingFocusBindingId : (() => { });

  const getDrag = (typeof getDragState === "function") ? getDragState : (() => null);
  const setDrag = (typeof setDragState === "function") ? setDragState : (() => { });

  function updateSliderFill(slider) {
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 1;
    const val = parseFloat(slider.value) || 0;
    const percent = ((val - min) / (max - min)) * 100;
    slider.style.backgroundSize = `${percent}% 100%`;
  }

  function isBindingTargetMenuOpen() {
    return Boolean(document.querySelector(".target-dropdown.open"));
  }

  function isBindingNameEditing() {
    return Boolean(document.querySelector(".binding-name-input:focus"));
  }

  function isBindingSelectEditing() {
    const active = document.activeElement;
    return Boolean(active && active.closest(".binding-item") && active.tagName === "SELECT");
  }

  function isBindingInteractionActive() {
    return isBindingTargetMenuOpen() || isBindingNameEditing() || isBindingSelectEditing();
  }

  function updateBindingValues() {
    const sliders = document.querySelectorAll(".binding-volume-slider");
    sliders.forEach((slider) => {
      const lastMidiUpdate = Number(slider.dataset.lastMidiUpdate || 0);
      if (Date.now() - lastMidiUpdate < 1000) return;

      let target = null;
      try {
        target = JSON.parse(slider.dataset.targetJson);
      } catch {
        return;
      }

      const vol = getVol(target);
      if (vol !== null && Math.abs(Number(slider.value) - vol) > 0.01) {
        slider.value = vol;
        updateSliderFill(slider);
        invoke("update_midi_feedback", { target, value: vol });
      }
    });

    const buttons = document.querySelectorAll(".binding-mute-button");
    buttons.forEach((btn) => {
      let target = null;
      try {
        target = JSON.parse(btn.dataset.targetJson);
      } catch {
        return;
      }

      const muted = Boolean(getMuted(target));
      const currentlyMuted = btn.classList.contains("muted");
      if (muted !== currentlyMuted) {
        btn.innerHTML = muted ? "\ud83d\udd07" : "\ud83d\udd0a";
        btn.classList.toggle("muted", muted);
        const val = muted ? 1.0 : 0.0;
        invoke("update_midi_feedback", { target, value: val });
      }
    });
  }

  function beginBindingEdit(bindingId) {
    setEditingId(bindingId);
    setPendingFocusId(bindingId);
    renderBindings();
  }

  function renderBindings() {
    const bindings = getB();
    d.bindingsContainer.innerHTML = "";

    if (!Array.isArray(bindings) || bindings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bindings-empty";
      empty.textContent = "No bindings yet. Use the button below to add one.";
      d.bindingsContainer.appendChild(empty);
      return;
    }

    bindings.forEach((binding, index) => {
      try {
        const item = document.createElement("div");
        item.className = "list-item binding-item";

        const row = document.createElement("div");
        row.className = "binding-row";

        item.dataset.index = index;

        const fallbackName = fallbackNameFor(binding, index);
        const isEditing = binding.id === getEditingId();
        let nameInput = null;
        let nameField = null;

        if (isEditing) {
          nameInput = document.createElement("input");
          nameInput.className = "binding-name-input";
          nameInput.value = binding.name?.trim() || fallbackName;
          nameInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              nameInput.blur();
            }
          });
          nameInput.addEventListener("blur", async () => {
            if (binding.id !== getEditingId()) {
              return;
            }
            const trimmedName = nameInput.value.trim();
            binding.name = trimmedName || fallbackName;
            setEditingId(null);
            await invoke("add_binding", { binding });
            await saveProfile();
            renderBindings();
          });
          nameField = nameInput;
        } else {
          const nameLabel = document.createElement("div");
          nameLabel.className = "binding-name";
          nameLabel.textContent = binding.name?.trim() || fallbackName;
          nameField = nameLabel;
        }

        const controlInfo = document.createElement("div");
        controlInfo.textContent = labelForControl(binding.control);

        const isButton = binding.control?.msg_type === "Note";
        console.log(
          "renderBindings binding:",
          binding.id,
          "action:",
          binding.action,
          "msg_type:",
          binding.control?.msg_type,
          "isButton:",
          isButton,
        );

        const modeSelect = document.createElement("select");
        if (isButton) {
          const option = document.createElement("option");
          option.value = "Toggle";
          option.textContent = "Toggle";
          modeSelect.appendChild(option);
          modeSelect.disabled = true;
          modeSelect.title = "Button bindings toggle mute state";
        } else {
          ["Absolute", "Relative"].forEach((mode) => {
            const option = document.createElement("option");
            option.value = mode;
            option.textContent = mode;
            if (binding.mode === mode) {
              option.selected = true;
            }
            modeSelect.appendChild(option);
          });

          modeSelect.addEventListener("change", () => {
            binding.mode = modeSelect.value;
            invoke("add_binding", { binding });
            saveProfile();
          });
        }

        const targetSelect = buildTarget(binding.target, isButton, binding.action);
        targetSelect.addEventListener("change", async () => {
          const kind = targetSelect.dataset.kind || "master";
          const selected = targetSelect.__selectedTarget;

          if (selected !== undefined) {
            binding.target = selected;
          } else {
            if (kind === "master") {
              binding.target = "Master";
            } else if (kind === "focus") {
              binding.target = "Focus";
            } else if (kind === "device") {
              binding.target = { Device: { device_id: targetSelect.value } };
            } else if (kind === "session") {
              binding.target = { Application: { name: targetSelect.value } };
            } else {
              binding.target = "Unset";
            }
          }

          if (isButton) {
            binding.action = targetSelect.dataset.action || binding.action || "ToggleMute";
          } else {
            binding.action = "Volume";
          }

          if (isButton) {
            binding.action = "ToggleMute";
          } else {
            const newVolume = getVol(binding.target);
            if (volumeSlider) {
              volumeSlider.value = newVolume;
              updateSliderFill(volumeSlider);
            }

            const newMuted = getMuted(binding.target);
            if (muteButton) {
              muteButton.innerHTML = newMuted ? "\ud83d\udd07" : "\ud83d\udd0a";
              muteButton.classList.toggle("muted", newMuted);
            }
          }

          invoke("add_binding", { binding });
          saveProfile();

          try {
            getHost()?.setBindings?.(getB());
          } catch { }
        });

        const volumeSlider = document.createElement("input");
        volumeSlider.type = "range";
        volumeSlider.className = "binding-volume-slider";
        volumeSlider.min = "0";
        volumeSlider.max = "1";
        volumeSlider.step = "0.01";
        volumeSlider.title = "Volume";

        if (isButton) {
          volumeSlider.disabled = true;
          volumeSlider.style.visibility = "hidden";
        } else {
          const v = getVol(binding.target);

          if (v !== null) bindingLastValues[binding.id] = v;
          volumeSlider.value = v ?? bindingLastValues[binding.id] ?? 0;
          updateSliderFill(volumeSlider);

          const targetJson = JSON.stringify(binding.target);
          volumeSlider.dataset.targetJson = targetJson;
          volumeSlider.dataset.bindingId = binding.id;

          volumeSlider.addEventListener("input", async (e) => {
            bindingInteractionTimes[binding.id] = Date.now();
            const vol = parseFloat(e.target.value);
            bindingLastValues[binding.id] = vol;
            updateSliderFill(e.target);
            try {
              const target = binding.target;
              let invoked = false;

              if (target === "Master" || target?.Master != null) {
                await invoke("set_master_volume", { volume: vol });
                invoked = true;
              } else if (target === "Focus" || target?.Focus != null) {
                // Focus volume not supported through this path.
              } else {
                const appContainer = target.Application || target.application;
                if (appContainer) {
                  const appName = appContainer.name ?? target.name;
                  await invoke("set_application_volume", { name: appName, volume: vol });
                  invoked = true;
                } else {
                  const sessionContainer = target.Session || target.session;
                  if (sessionContainer) {
                    const sessId = sessionContainer.session_id ?? sessionContainer.sessionId ?? target.session_id;
                    await invoke("set_session_volume", { sessionId: sessId, volume: vol });
                    invoked = true;
                  } else {
                    const deviceContainer = target.Device || target.device;
                    if (deviceContainer) {
                      let devId = deviceContainer.device_id ?? deviceContainer.deviceId ?? target.device_id;

                      if (devId && typeof devId === "string") {
                        devId = devId.trim();
                        if (!devId.startsWith("recording:") && !devId.startsWith("playback:")) {
                          const recordingDevices = getRecording();
                          const playbackDevices = getPlayback();
                          if (Array.isArray(recordingDevices) && recordingDevices.some((d) => d && d.id === devId)) {
                            devId = `recording:${devId}`;
                          } else if (Array.isArray(playbackDevices) && playbackDevices.some((d) => d && d.id === devId)) {
                            devId = `playback:${devId}`;
                          }
                        }
                      }

                      console.log("[JS] set_device_volume inputs:", { devId, vol });
                      await invoke("set_device_volume", { deviceId: devId, volume: vol });
                      invoked = true;
                    } else {
                      if (await trigIntegration(binding, "Volume", vol)) {
                        invoked = true;
                      }
                    }
                  }
                }
              }

              if (invoked) {
                showVolOsd(target, vol);

                volumeSlider.dataset.lastMidiUpdate = Date.now();
                if (!extractInteg(target)) {
                  invoke("update_midi_feedback", { target, value: vol, action: "Volume" });
                }
              }
            } catch (err) {
              console.error("Failed to set volume:", err);
            }
          });
        }

        const muteButton = document.createElement("button");
        muteButton.type = "button";
        muteButton.className = "binding-mute-button";
        muteButton.title = "Toggle Mute";
        const isMuted = (bindingMuteValues[binding.id] != null)
          ? Boolean(bindingMuteValues[binding.id])
          : Boolean(getMuted(binding.target));
        muteButton.innerHTML = isMuted ? "\ud83d\udd07" : "\ud83d\udd0a";
        muteButton.classList.toggle("muted", isMuted);
        muteButton.dataset.targetJson = JSON.stringify(binding.target);

        if (isButton) {
          muteButton.disabled = true;
          muteButton.style.visibility = "hidden";
        }

        muteButton.addEventListener("click", async () => {
          bindingInteractionTimes[binding.id] = Date.now();
          const currentlyMuted = muteButton.classList.contains("muted");
          const newMuted = !currentlyMuted;

          try {
            const target = binding.target;
            let invoked = false;

            if (target === "Master" || target?.Master != null) {
              await invoke("set_master_mute", { muted: newMuted });
              invoked = true;
            } else if (target === "Focus" || target?.Focus != null) {
              // Focus mute not supported
            } else {
              const appContainer = target.Application || target.application;
              if (appContainer) {
                const appName = appContainer.name ?? target.name;
                await invoke("set_application_mute", { name: appName, muted: newMuted });
                invoked = true;
              } else {
                const sessionContainer = target.Session || target.session;
                if (sessionContainer) {
                  const sessId = sessionContainer.session_id ?? sessionContainer.sessionId ?? target.session_id;
                  await invoke("set_session_mute", { sessionId: sessId, muted: newMuted });
                  invoked = true;
                } else {
                  const deviceContainer = target.Device || target.device;
                  if (deviceContainer) {
                    let devId = deviceContainer.device_id ?? deviceContainer.deviceId ?? target.device_id;
                    if (devId && typeof devId === "string") {
                      devId = devId.trim();
                      if (!devId.startsWith("recording:") && !devId.startsWith("playback:")) {
                        const recordingDevices = getRecording();
                        const playbackDevices = getPlayback();
                        if (Array.isArray(recordingDevices) && recordingDevices.some((d) => d && d.id === devId)) {
                          devId = `recording:${devId}`;
                        } else if (Array.isArray(playbackDevices) && playbackDevices.some((d) => d && d.id === devId)) {
                          devId = `playback:${devId}`;
                        }
                      }
                    }
                    if (devId) {
                      await invoke("set_device_mute", { device_id: devId, muted: newMuted });
                      invoked = true;
                    } else {
                      if (await trigIntegration(binding, "ToggleMute", newMuted ? 1.0 : 0.0)) {
                        invoked = true;
                      }
                    }
                  }
                }
              }
            }

            if (invoked) {
              showMutOsd(target, newMuted);
              muteButton.innerHTML = newMuted ? "\ud83d\udd07" : "\ud83d\udd0a";
              muteButton.classList.toggle("muted", newMuted);
            }
          } catch (err) {
            console.error("Failed to toggle mute:", err);
          }
        });

        const volumeGroup = document.createElement("div");
        volumeGroup.className = "binding-volume-group";
        volumeGroup.appendChild(volumeSlider);
        volumeGroup.appendChild(muteButton);

        const actions = document.createElement("div");
        actions.className = "binding-actions";

        const dragButton = document.createElement("button");
        dragButton.type = "button";
        dragButton.className = "binding-action binding-drag";
        dragButton.textContent = "\u2195";
        dragButton.title = "Drag to reorder";
        dragButton.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          dragButton.setPointerCapture(event.pointerId);
          startBindingDrag(item, index, event);
        });
        dragButton.addEventListener("pointerup", (event) => {
          dragButton.releasePointerCapture(event.pointerId);
        });

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "binding-action";
        editButton.textContent = "\u270e";
        editButton.title = "Edit name";
        editButton.addEventListener("click", () => {
          beginBindingEdit(binding.id);
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "binding-action delete";
        deleteButton.textContent = "\u00d7";
        deleteButton.title = "Delete binding";
        deleteButton.addEventListener("click", async () => {
          try {
            await invoke("remove_binding", { binding });
            const next = getB();
            next.splice(index, 1);
            setB(next);
            renderBindings();
          } catch (err) {
            console.error("Failed to remove binding:", err);
          }
        });

        actions.appendChild(dragButton);
        actions.appendChild(editButton);
        actions.appendChild(deleteButton);

        row.appendChild(nameField);
        row.appendChild(volumeGroup);
        row.appendChild(modeSelect);
        row.appendChild(targetSelect);
        row.appendChild(actions);
        item.appendChild(row);
        d.bindingsContainer.appendChild(item);

        if (binding.id === getPendingFocusId() && nameInput) {
          setPendingFocusId(null);
          setEditingId(binding.id);
          nameInput.focus();
          nameInput.select();
        }
      } catch (err) {
        const errorItem = document.createElement("div");
        errorItem.className = "list-item binding-item error-binding";
        errorItem.textContent = `Error: ${err.message || err}`;
        errorItem.style.color = "red";
        errorItem.style.padding = "10px";

        const delBtn = document.createElement("button");
        delBtn.textContent = "\ud83d\uddd1";
        delBtn.className = "icon-button danger";
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (confirm("Delete broken binding?")) {
            try {
              await invoke("remove_binding", { binding });
            } catch { }
            await saveProfile();
            renderBindings();
          }
        };
        errorItem.appendChild(delBtn);

        d.bindingsContainer.appendChild(errorItem);
      }
    });
  }

  function startBindingDrag(item, index, event) {
    const rect = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add("binding-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.opacity = "0";

    const placeholder = document.createElement("div");
    placeholder.className = "binding-placeholder";
    placeholder.style.height = `${rect.height}px`;

    document.body.appendChild(ghost);

    setDrag({
      index,
      item,
      ghost,
      placeholder,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    });

    item.classList.add("dragging");
    document.body.classList.add("dragging-binding");
  }

  function updateBindingDrag(event) {
    const dragState = getDrag();
    if (!dragState) return;

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.active) {
      if (Math.hypot(deltaX, deltaY) < 6) {
        return;
      }
      dragState.active = true;
      dragState.item.style.display = "none";
      d.bindingsContainer.insertBefore(dragState.placeholder, dragState.item.nextSibling);
      dragState.ghost.style.opacity = "0.85";
    }

    dragState.ghost.style.left = `${event.clientX - dragState.offsetX}px`;
    dragState.ghost.style.top = `${event.clientY - dragState.offsetY}px`;

    const target = document.elementFromPoint(event.clientX, event.clientY);
    const bindingItem = target?.closest(".binding-item");
    if (!bindingItem || bindingItem === dragState.item) {
      return;
    }

    const rect = bindingItem.getBoundingClientRect();
    const insertBefore = event.clientY < rect.top + rect.height / 2;
    const reference = insertBefore ? bindingItem : bindingItem.nextSibling;
    if (reference !== dragState.placeholder) {
      d.bindingsContainer.insertBefore(dragState.placeholder, reference);
    }
  }

  function placeholderIndex() {
    const children = Array.from(d.bindingsContainer.children);
    let index = 0;
    for (const child of children) {
      if (child.classList.contains("binding-placeholder")) {
        return index;
      }
      if (child.classList.contains("binding-item")) {
        index += 1;
      }
    }
    return null;
  }

  async function endBindingDrag() {
    const dragState = getDrag();
    if (!dragState) return;
    const { index, item, ghost, placeholder, active } = dragState;
    const newIndex = active ? placeholderIndex() : null;
    setDrag(null);

    item.style.display = "";
    item.classList.remove("dragging");
    ghost.remove();
    if (active) {
      placeholder.remove();
    }
    document.body.classList.remove("dragging-binding");

    if (active && newIndex !== null && newIndex !== index) {
      const insertIndex = (newIndex > index) ? (newIndex - 1) : newIndex;
      const next = getB();
      const [moved] = next.splice(index, 1);
      next.splice(insertIndex, 0, moved);
      setB(next);
      renderBindings();
      await saveProfile();
    }
  }

  function cancelBindingDrag() {
    const dragState = getDrag();
    if (!dragState) return;
    dragState.item.style.display = "";
    dragState.item.classList.remove("dragging");
    dragState.ghost.remove();
    if (dragState.active) {
      dragState.placeholder.remove();
    }
    setDrag(null);
    document.body.classList.remove("dragging-binding");
  }

  return {
    updateSliderFill,
    isBindingInteractionActive,
    updateBindingValues,
    beginBindingEdit,
    renderBindings,
    startBindingDrag,
    updateBindingDrag,
    endBindingDrag,
    cancelBindingDrag,
  };
}
