import { createJourneyUi } from "../webdriver/journey-ui.mjs";

// Serialized into the renderer. CDP uses DOM events, not physical pointer input.
function operateOnElement(selector, operation, value) {
  const element = document.querySelector(selector);
  if (operation === "displayed" || operation === "clickable") {
    const visible = Boolean(
      element &&
        element.isConnected &&
        !element.closest(".hidden,[hidden]") &&
        element.getClientRects().length &&
        getComputedStyle(element).display !== "none" &&
        getComputedStyle(element).visibility !== "hidden",
    );
    return visible && (operation === "displayed" || !element.disabled);
  }
  if (operation === "enabled") return Boolean(element && !element.disabled);
  if (!element) throw new Error(`Missing journey element: ${selector}`);
  if (operation === "text") return element.textContent;
  if (operation === "attribute") return element.getAttribute(value);
  if (operation === "click") {
    element.click();
    return;
  }
  if (operation === "clear") {
    element.value = "";
    return;
  }
  if (operation === "fill") {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  throw new Error(`Unsupported CDP element operation: ${operation}`);
}

/** Adapt evaluate(session, expression) to the shared WebDriver journey policy. */
export function createCdpJourneyUi({
  session,
  evaluate,
  waitForAuditMarker,
  timeoutMs = 5000,
  pollIntervalMs = 20,
}) {
  if (typeof evaluate !== "function")
    throw new Error("CDP journey UI requires evaluate(session, expression)");
  const execute = (callback, ...args) => evaluate(session, `(${callback})(...${JSON.stringify(args)})`);
  async function waitUntil(
    predicate,
    { timeout = timeoutMs, timeoutMsg = "CDP journey wait did not complete" } = {},
  ) {
    const deadline = performance.now() + timeout;
    while (true) {
      if (await predicate()) return true;
      if (performance.now() >= deadline) throw new Error(timeoutMsg);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  const browser = {
    execute,
    waitUntil,
    executeAsync(callback) {
      return evaluate(
        session,
        `new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CDP journey frame did not complete")), ${JSON.stringify(timeoutMs)});
        try {
          (${callback})((value) => { clearTimeout(timer); resolve(value); });
        } catch (error) { clearTimeout(timer); reject(error); }
      })`,
      );
    },
  };
  const select = async (selector) => {
    const operation = (name, value) => execute(operateOnElement, selector, name, value);
    const waitFor = (name, expected = true) =>
      waitUntil(async () => (await operation(name)) === expected, {
        timeoutMsg: `CDP journey expected ${selector} to be ${expected ? "" : "not "}${name}`,
      });
    return {
      isDisplayed: () => operation("displayed"),
      waitForDisplayed: ({ reverse = false } = {}) => waitFor("displayed", !reverse),
      waitForClickable: () => waitFor("clickable"),
      waitForEnabled: () => waitFor("enabled"),
      click: () => operation("click"),
      clearValue: () => operation("clear"),
      setValue: (value) => operation("fill", value),
      getText: () => operation("text"),
      getAttribute: (name) => operation("attribute", name),
      dragAndDrop() {
        throw new Error("CDP DOM-event journeys do not implement drag; use the WebDriver journey");
      },
    };
  };
  const waitMarker =
    waitForAuditMarker ||
    ((name) =>
      waitUntil(
        () =>
          execute(
            (marker) =>
              window.__MIDIMASTER_PERF__?.snapshot?.().entries?.some((entry) => entry.name === marker) ||
              false,
            name,
          ),
        {
          timeoutMsg: `Audit marker '${name}' was not observed`,
        },
      ));
  return createJourneyUi({ browser, select, waitForAuditMarker: waitMarker });
}
