export function createAlertsController({
  alertOverlay,
  alertTitle,
  alertMessage,
  alertClose,
  alertSecondary,
  alertCancel,
  alertOk,
}) {
  let pendingChoiceResolve = null;
  let pendingMode = "alert";

  function resolveChoice(value) {
    if (!pendingChoiceResolve) return;
    const resolve = pendingChoiceResolve;
    pendingChoiceResolve = null;
    pendingMode = "alert";
    resolve(value);
  }

  function setButtonConfig(button, config = null) {
    if (!button) return;
    if (!config) {
      button.classList.add("hidden");
      button.classList.remove("primary-button", "secondary-button", "danger-button", "secondary");
      delete button.dataset.choiceId;
      return;
    }
    button.textContent = config.label || "";
    button.dataset.choiceId = config.id || "";
    button.classList.remove("hidden");
    const isPrimary = config.variant === "primary";
    const isDanger = config.variant === "danger";
    button.classList.toggle("secondary", !isPrimary);
    button.classList.toggle("secondary-button", !isPrimary && !isDanger);
    button.classList.toggle("primary-button", isPrimary);
    button.classList.toggle("danger-button", isDanger);
  }

  function setActionsMode(mode = "alert", config = {}) {
    pendingMode = mode;
    if (!alertOk) return;
    if (mode === "alert") {
      setButtonConfig(alertSecondary, null);
      setButtonConfig(alertCancel, null);
      setButtonConfig(alertOk, { label: "OK", variant: "primary" });
      return;
    }
    if (mode === "confirm") {
      setButtonConfig(alertSecondary, null);
      setButtonConfig(alertCancel, { label: config.cancelLabel || "Cancel", variant: "secondary" });
      setButtonConfig(alertOk, {
        label: config.confirmLabel || "Confirm",
        variant: config.confirmVariant || "primary",
      });
      return;
    }
    if (mode === "choice") {
      const options = Array.isArray(config.options) ? config.options : [];
      if (options.length === 2) {
        setButtonConfig(alertSecondary, options[0] || null);
        setButtonConfig(alertCancel, null);
        setButtonConfig(alertOk, options[1] || null);
        return;
      }
      setButtonConfig(alertSecondary, options[0] || null);
      setButtonConfig(alertCancel, options[1] || null);
      setButtonConfig(alertOk, options[2] || null);
    }
  }

  function showAlert(message, title = "Alert") {
    if (!alertOverlay || !alertMessage) {
      return;
    }
    resolveChoice("close");
    if (alertTitle) {
      alertTitle.textContent = title;
    }
    setActionsMode("alert");
    alertMessage.textContent = message;
    alertOverlay.classList.remove("hidden");
  }

  function showConfirm({
    title = "Confirm",
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    confirmVariant = "primary",
  } = {}) {
    if (!alertOverlay || !alertMessage) {
      return Promise.resolve(false);
    }
    resolveChoice("cancel");
    if (alertTitle) {
      alertTitle.textContent = title;
    }
    setActionsMode("confirm", { confirmLabel, cancelLabel, confirmVariant });
    alertMessage.textContent = message;
    alertOverlay.classList.remove("hidden");
    return new Promise((resolve) => {
      pendingChoiceResolve = (value) => resolve(value === "confirm");
    });
  }

  function showChoices({
    title = "Choose",
    message = "",
    options = [],
  } = {}) {
    if (!alertOverlay || !alertMessage) {
      return Promise.resolve("close");
    }
    const safeOptions = Array.isArray(options)
      ? options.filter((option) => option && typeof option.id === "string")
      : [];
    if (safeOptions.length < 2 || safeOptions.length > 3) {
      return Promise.resolve("close");
    }
    resolveChoice("close");
    if (alertTitle) {
      alertTitle.textContent = title;
    }
    setActionsMode("choice", { options: safeOptions });
    alertMessage.textContent = message;
    alertOverlay.classList.remove("hidden");
    return new Promise((resolve) => {
      pendingChoiceResolve = resolve;
    });
  }

  function closeAlert() {
    resolveChoice("close");
    if (alertOverlay) {
      alertOverlay.classList.add("hidden");
    }
    setActionsMode("alert");
  }

  function bindUi() {
    if (alertClose) {
      alertClose.addEventListener("click", closeAlert);
    }

    if (alertOk) {
      alertOk.addEventListener("click", () => {
        if (pendingChoiceResolve) {
          if (pendingMode === "confirm") {
            resolveChoice("confirm");
          } else if (pendingMode === "choice") {
            resolveChoice(alertOk.dataset.choiceId || "close");
          } else {
            resolveChoice("close");
          }
          if (alertOverlay) {
            alertOverlay.classList.add("hidden");
          }
          setActionsMode("alert");
          return;
        }
        closeAlert();
      });
    }

    if (alertSecondary) {
      alertSecondary.addEventListener("click", () => {
        if (pendingChoiceResolve && pendingMode === "choice") {
          resolveChoice(alertSecondary.dataset.choiceId || "close");
          if (alertOverlay) {
            alertOverlay.classList.add("hidden");
          }
          setActionsMode("alert");
          return;
        }
        closeAlert();
      });
    }

    if (alertCancel) {
      alertCancel.addEventListener("click", () => {
        if (pendingChoiceResolve) {
          if (pendingMode === "confirm") {
            resolveChoice("cancel");
          } else if (pendingMode === "choice") {
            resolveChoice(alertCancel.dataset.choiceId || "close");
          } else {
            resolveChoice("close");
          }
          if (alertOverlay) {
            alertOverlay.classList.add("hidden");
          }
          setActionsMode("alert");
          return;
        }
        closeAlert();
      });
    }

    if (alertOverlay) {
      alertOverlay.addEventListener("click", (event) => {
        if (event.target === alertOverlay) {
          closeAlert();
        }
      });
    }
  }

  return {
    showAlert,
    showConfirm,
    showChoices,
    closeAlert,
    bindUi,
  };
}
