/** create row name workflow. */
export function createRowNameController({
  beginBindingEdit,
  fallbackNameFor,
  finishBindingUiMutation,
  flushPendingRerender,
  getEditingId,
  getPendingFocusId,
  invoke,
  nameDrafts,
  setEditingId,
  setPendingFocusId,
  t,
}) {
  function createRowName(binding, index) {
    const fallbackName = fallbackNameFor(binding, index);
    const isEditing = binding.id === getEditingId();
    let nameInput = null;
    let nameField = null;

    if (isEditing) {
      nameInput = document.createElement("input");
      nameInput.className = "binding-name-input";
      nameInput.dataset.bindingId = String(binding.id || "");
      nameInput.name = `binding-name-${binding.id || "new"}`;
      nameInput.autocomplete = "new-password";
      nameInput.autocorrect = "off";
      nameInput.autocapitalize = "off";
      nameInput.spellcheck = false;
      nameInput.setAttribute("data-lpignore", "true");
      nameInput.value = (nameDrafts.get(binding.id) ?? binding.name?.trim()) || fallbackName;
      ["pointerdown", "mousedown", "click"].forEach((eventName) => {
        nameInput.addEventListener(eventName, (event) => {
          event.stopPropagation();
        });
      });
      nameInput.addEventListener("input", () => {
        nameDrafts.set(binding.id, nameInput.value);
        if (binding.id === getPendingFocusId()) {
          setPendingFocusId(null);
        }
      });
      nameInput.addEventListener("keydown", (event) => {
        if (binding.id === getPendingFocusId() && event.key.length === 1) {
          setPendingFocusId(null);
        }
        if (event.key === "Enter") {
          event.preventDefault();
          nameInput.blur();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          nameDrafts.delete(binding.id);
          setEditingId(null);
          setPendingFocusId(null);
          flushPendingRerender({ fallbackRender: true });
        }
      });
      nameInput.addEventListener("blur", async () => {
        if (binding.id !== getEditingId()) {
          return;
        }
        // While pending auto-focus is active for a newly created binding,
        // ignore transient blur events from background rerenders/feedback updates.
        if (binding.id === getPendingFocusId()) {
          return;
        }
        // A rerender can briefly blur/recreate the input. Wait one tick and
        // only commit if we are no longer editing a binding-name input.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (binding.id !== getEditingId()) {
          return;
        }
        if (binding.id === getPendingFocusId()) {
          return;
        }
        const activeEl = document.activeElement;
        if (activeEl && activeEl.classList?.contains("binding-name-input")) {
          return;
        }
        const draftValue = nameDrafts.get(binding.id);
        const trimmedName = (draftValue ?? nameInput.value).trim();
        nameDrafts.delete(binding.id);
        binding.name = trimmedName || fallbackName;
        setEditingId(null);
        setPendingFocusId(null);
        await invoke("add_binding", { binding });
        flushPendingRerender({ fallbackRender: true });
        finishBindingUiMutation("rename binding");
      });
      nameField = nameInput;
    } else {
      const nameLabel = document.createElement("div");
      nameLabel.className = "binding-name";
      nameLabel.textContent = binding.name?.trim() || fallbackName;
      nameLabel.title = t("bindings.doubleClickRename");
      nameLabel.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });
      nameLabel.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        beginBindingEdit(binding.id, true);
      });
      nameField = nameLabel;
    }

    return { nameInput, nameField };
  }

  return { createRowName };
}
