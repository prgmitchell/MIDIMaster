/** binding feedback workflow. */
export function createBindingFeedback({ features }) {
  function setInlineMuteButtonState(button, muted) {
    features.bindings?.setMuteButtonState?.(button, muted);
  }

  function findInlineMuteButton(bindingId) {
    if (bindingId == null) return null;
    return (
      features.bindings?.getRenderedBindingRefs?.(bindingId)?.muteButton ||
      document.querySelector(`.binding-mute-button[data-binding-id="${CSS.escape(String(bindingId))}"]`)
    );
  }

  return { setInlineMuteButtonState, findInlineMuteButton };
}
