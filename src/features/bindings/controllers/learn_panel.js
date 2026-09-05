/** learn panel workflow. */
export function createLearnPanel({
  elements,
  defaultLearnPanelMessage,
  defaultLearnPanelTitle,
  editorState,
  t,
  updateAuxLearnUi,
}) {
  function clearTransferPrompt() {
    editorState.transferPrompt = null;
  }

  function setTransferPrompt(nextPrompt) {
    editorState.transferPrompt = nextPrompt || null;
    updateAuxLearnUi();
  }

  function hasLearnPanelSupport() {
    return Boolean(elements.learnPanel);
  }

  function resetLearnPanelUi() {
    if (!hasLearnPanelSupport()) return;
    if (elements.learnPanelTitle) elements.learnPanelTitle.textContent = defaultLearnPanelTitle();
    if (elements.learnPanelMessage) elements.learnPanelMessage.textContent = defaultLearnPanelMessage();
    if (elements.learnPanelSpinner) elements.learnPanelSpinner.classList.remove("hidden");
    if (elements.learnPanelActions) elements.learnPanelActions.classList.add("hidden");
    if (elements.learnPanelCancel) elements.learnPanelCancel.textContent = t("common.cancel");
    if (elements.learnPanelConfirm) {
      elements.learnPanelConfirm.textContent = t("common.transfer");
      elements.learnPanelConfirm.classList.remove("hidden");
    }
  }

  function showLearnPanel() {
    if (!hasLearnPanelSupport()) return;
    elements.learnPanel.classList.remove("hidden");
  }

  function hideLearnPanel() {
    if (!hasLearnPanelSupport()) return;
    elements.learnPanel.classList.add("hidden");
    resetLearnPanelUi();
  }

  function setLearnPanelWaiting() {
    if (!hasLearnPanelSupport()) return;
    if (elements.learnPanelTitle) elements.learnPanelTitle.textContent = defaultLearnPanelTitle();
    if (elements.learnPanelMessage) elements.learnPanelMessage.textContent = defaultLearnPanelMessage();
    if (elements.learnPanelSpinner) elements.learnPanelSpinner.classList.remove("hidden");
    if (elements.learnPanelActions) elements.learnPanelActions.classList.add("hidden");
    showLearnPanel();
  }

  function setLearnPanelTransfer(message) {
    if (!hasLearnPanelSupport()) return;
    if (elements.learnPanelTitle) elements.learnPanelTitle.textContent = t("bindings.transferMapping");
    if (elements.learnPanelMessage) elements.learnPanelMessage.textContent = message || "";
    if (elements.learnPanelSpinner) elements.learnPanelSpinner.classList.add("hidden");
    if (elements.learnPanelActions) elements.learnPanelActions.classList.remove("hidden");
    if (elements.learnPanelCancel) elements.learnPanelCancel.textContent = t("common.cancel");
    if (elements.learnPanelConfirm) {
      elements.learnPanelConfirm.textContent = t("common.transfer");
      elements.learnPanelConfirm.classList.remove("hidden");
    }
    showLearnPanel();
  }

  return {
    clearTransferPrompt,
    setTransferPrompt,
    resetLearnPanelUi,
    hideLearnPanel,
    setLearnPanelWaiting,
    setLearnPanelTransfer,
  };
}
