function isRendered(element) {
  return Boolean(element?.isConnected && !element.closest(".hidden,[hidden],.visually-hidden"));
}

/** Binding sliders display hundredths; adjacent slider steps are different results. */
export function matchesRenderedBindingValue(observed, expected) {
  return Number.isFinite(observed) && Number.isFinite(expected)
    && Math.abs(observed - Math.round(expected * 100) / 100) < 0.000001;
}

/** Read the displayed binding control for audit verification, never its hidden proxy. */
export function readRenderedBindingValue(refs, payload, documentSource = globalThis.document) {
  if (documentSource?.visibilityState === "hidden" || !isRendered(refs?.item)) return null;
  const button = refs.item.querySelector(".binding-toggle-value,.binding-momentary-value");
  if (isRendered(button)) {
    const activeClass = button.classList.contains("binding-toggle-value") ? "on" : "is-active";
    return Number(button.classList.contains(activeClass));
  }
  if (typeof payload?.muted === "boolean") {
    return isRendered(refs.muteButton) ? Number(refs.muteButton.classList.contains("muted")) : null;
  }
  if (isRendered(refs.slider) && !refs.slider.disabled) return Number(refs.slider.value);
  return null;
}
