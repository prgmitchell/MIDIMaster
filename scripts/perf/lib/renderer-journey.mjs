/** Runs inside the renderer through WebDriver or CDP; no driver time is included. */
export function armRendererJourney(contract, environment = globalThis) {
  const { document, performance, MutationObserver } = environment;
  environment.__MIDIMASTER_JOURNEY__?.cancel?.();
  let startedAt = null;
  let frame = null;
  let verifying = false;
  const state = { id: contract.id, result: null, error: null, cancel };
  environment.__MIDIMASTER_JOURNEY__ = state;
  const conditions = (contract.completion || []).map((condition) => ({
    ...condition,
    expected: condition.expected === "$initialCount"
      ? document.querySelectorAll(condition.selector).length : condition.expected,
  }));

  function matches(condition) {
    const element = document.querySelector(condition.selector);
    if (condition.kind === "count") return document.querySelectorAll(condition.selector).length === condition.expected;
    if (condition.kind === "absent") return !element;
    if (!element) return false;
    if (condition.kind === "value") return element.value === condition.expected;
    if (condition.kind === "attribute") return element.getAttribute(condition.name) === condition.expected;
    if (condition.kind === "text") return element.textContent.includes(condition.expected);
    if (condition.kind === "visible" || condition.kind === "hidden") {
      const visible = !element.closest(".hidden,[hidden]") && environment.getComputedStyle(element).display !== "none";
      return visible === (condition.kind === "visible");
    }
    throw new Error(`Unknown renderer completion condition: ${condition.kind}`);
  }

  function cancel() {
    document.removeEventListener(contract.start.event, onInput, true);
    observer.disconnect();
    if (frame != null) environment.cancelAnimationFrame(frame);
    environment.clearTimeout(timeout);
    frame = null;
  }

  function check() {
    frame = null;
    if (startedAt == null || state.result) return;
    if (!conditions.every(matches)) { verifying = false; return; }
    // A second frame confirms the result survived a render opportunity. This is
    // event-to-render timing, not a claim about photons reaching the display.
    if (!verifying) { verifying = true; schedule(); return; }
    state.result = { id: contract.id, metric: contract.metric, durationMs: performance.now() - startedAt };
    cancel();
  }

  function schedule() {
    if (startedAt != null && frame == null && !state.result) frame = environment.requestAnimationFrame(check);
  }

  function onInput(event) {
    const target = contract.start.selector ? event.target?.closest?.(contract.start.selector) : event.target;
    if (!target || (contract.start.value != null && target.value !== contract.start.value)) return;
    startedAt = performance.now();
    verifying = false;
    schedule();
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
  document.addEventListener(contract.start.event, onInput, true);
  const timeout = environment.setTimeout(() => {
    state.error = `Renderer journey ${contract.id} did not reach its expected result`;
    cancel();
  }, contract.timeoutMs || 30000);
  return true;
}

/** Serializable getter for browser.execute/Runtime.evaluate. */
export function readRendererJourney() {
  const state = globalThis.__MIDIMASTER_JOURNEY__;
  return state ? { id: state.id, result: state.result, error: state.error } : null;
}
