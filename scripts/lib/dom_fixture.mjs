import { readAppHtml } from "./app_html.mjs";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";

/** A real DOM with a controlled frame queue; layout and hardware remain desktop tests. */
export async function createAppDom() {
  const html = await readAppHtml();
  const { document, window } = parseHTML(html);
  const frames = new Map();
  let frameId = 0;
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`) },
    requestAnimationFrame: (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    getComputedStyle: (element) => ({
      getPropertyValue: (name) => element.style.getPropertyValue(name) || "",
    }),
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() {
      return this.querySelector("option[selected]")?.value ?? this.querySelector("option")?.value ?? "";
    },
    set(value) {
      this.querySelectorAll("option").forEach((option) => {
        option.toggleAttribute("selected", option.value === String(value));
      });
    },
  });
  return {
    document,
    window,
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    },
  };
}
