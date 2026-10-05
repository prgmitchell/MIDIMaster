import { normalizeOpenApplicationMapping } from "../../../core/action_mappings.js";

export function createApplicationEditor({ elements, openTargetPanel, closeTargetPanel, pickOpenApplication, t }) {
  function openApplicationEditor(current, onSave, onBack) {
    const isCurrent = openTargetPanel([], null, null, () => false, t("targets.openApplication"), { onBack });
    const panel = elements.targetPanel;
    const list = elements.targetPanelList;
    if (!panel || !list) return;
    panel.classList.add("target-panel--application");
    let selected = normalizeOpenApplicationMapping(current);
    const form = document.createElement("form");
    form.className = "application-launch-editor";
    const field = (title, input) => {
      const label = document.createElement("label");
      const caption = document.createElement("span");
      caption.textContent = title;
      label.append(caption, input);
      return label;
    };
    const path = document.createElement("input");
    path.type = "text";
    path.readOnly = true;
    path.value = selected?.path || "";
    path.placeholder = t("targets.applicationNotSelected");
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "binding-config-button binding-config-button--secondary";
    browse.textContent = t("targets.chooseApplication");
    const application = field(t("targets.application"), path);
    application.className = "application-launch-path";
    application.append(browse);
    const parameters = document.createElement("input");
    parameters.type = "text";
    parameters.value = selected?.arguments || "";
    parameters.placeholder = t("targets.applicationParametersPlaceholder");
    const help = document.createElement("p");
    help.textContent = t("targets.applicationParametersHelp");
    const error = document.createElement("p");
    error.className = "application-launch-error hidden";
    error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "application-launch-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "binding-config-button binding-config-button--secondary";
    cancel.textContent = t("common.cancel");
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "binding-config-button binding-config-button--primary";
    save.textContent = t("common.save");
    save.disabled = !selected;
    actions.append(cancel, save);
    form.append(application, field(t("targets.applicationParameters"), parameters), help, error, actions);
    list.replaceChildren(form);
    browse.addEventListener("click", async () => {
      browse.disabled = true;
      error.classList.add("hidden");
      try {
        const picked = await pickOpenApplication();
        if (!isCurrent?.() || !picked) return;
        selected = picked;
        path.value = selected.path;
        save.disabled = false;
      } catch {
        error.textContent = t("targets.applicationPickFailed");
        error.classList.remove("hidden");
      } finally {
        browse.disabled = false;
      }
    });
    cancel.addEventListener("click", () => {
      if (onBack) onBack();
      else closeTargetPanel();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!selected || !isCurrent?.()) return;
      onSave(normalizeOpenApplicationMapping({ ...selected, arguments: parameters.value }));
      closeTargetPanel();
    });
    browse.focus();
  }
  return { openApplicationEditor };
}
