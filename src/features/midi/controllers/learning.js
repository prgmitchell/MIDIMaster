/** learning workflow. */
export function createLearning({
  elements,
  learning,
  sessionRefreshScheduler,
  t,
  invoke,
}) {
  function startSessionRefresh(refreshFn, mainScreenEl) {
    sessionRefreshScheduler.start(refreshFn, mainScreenEl);
  }

  function stopSessionRefresh() {
    sessionRefreshScheduler.stop();
  }

  function closeLearnPanel() {
    if (!elements.learnPanel) {
      return;
    }
    elements.learnPanel.classList.add("hidden");
    if (elements.learnPanelTitle) {
      elements.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
    }
    if (elements.learnPanelSpinner) {
      elements.learnPanelSpinner.classList.remove("hidden");
    }
    if (elements.learnPanelActions) {
      elements.learnPanelActions.classList.add("hidden");
    }
  }

  function openLearnPanel(message) {
    if (!elements.learnPanel) {
      return;
    }
    if (elements.learnPanelTitle) {
      elements.learnPanelTitle.textContent = t("bindings.waitingMidiTitle");
    }
    if (elements.learnPanelSpinner) {
      elements.learnPanelSpinner.classList.remove("hidden");
    }
    if (elements.learnPanelActions) {
      elements.learnPanelActions.classList.add("hidden");
    }
    if (elements.learnPanelMessage && message) {
      elements.learnPanelMessage.textContent = message;
    }
    elements.learnPanel.classList.remove("hidden");
  }

  function cancelLearnPanel() {
    if (learning.learnTimer) {
      clearInterval(learning.learnTimer);
      learning.learnTimer = null;
      invoke("cancel_midi_learn").catch((error) =>
        console.error("Failed to cancel MIDI learning", error),
      );
    }
    closeLearnPanel();
  }

  return {
    startSessionRefresh,
    stopSessionRefresh,
    closeLearnPanel,
    openLearnPanel,
    cancelLearnPanel,
  };
}
