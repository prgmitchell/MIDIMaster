/** Journey setup stays outside the renderer's measured interaction. */
export function createJourneyUi({ browser, select, waitForAuditMarker }) {
  async function nextFrame() {
    await browser.executeAsync((done) => requestAnimationFrame(() => done(true)));
  }

  async function runStep(step) {
    if (step.action === "wait-marker") return waitForAuditMarker(step.name);
    if (step.action === "next-frame") return nextFrame();
    const element = await select(step.selector);
    if (step.action === "click") {
      await element.waitForClickable();
      return element.click();
    }
    if (step.action === "fill") {
      await element.waitForEnabled();
      await element.clearValue();
      return element.setValue(step.value);
    }
    if (step.action === "wait-visible") return element.waitForDisplayed();
    if (step.action === "wait-hidden") return element.waitForDisplayed({ reverse: true });
    if (step.action === "wait-text")
      return browser.waitUntil(async () => (await element.getText()).trim() === step.value);
    if (step.action === "wait-attribute")
      return browser.waitUntil(async () => (await element.getAttribute(step.name)) === step.value);
    if (step.action === "drag") return element.dragAndDrop(await select(step.destination));
    throw new Error(`Unsupported journey action: ${step.action}`);
  }

  async function reloadCurrentProfile() {
    await browser.execute(() => {
      if (!window.__MIDIMASTER_PERF__?.enabled) {
        throw new Error("Profile reload settlement requires an enabled performance audit");
      }
    });
    const name = (await (await select("#profile-current")).getText()).trim();
    if (!name) throw new Error("Cannot reload a profile without a current profile name");
    if (!(await (await select("#profile-list")).isDisplayed())) {
      await runStep({ action: "click", selector: "#profile-toggle" });
    }
    await runStep({ action: "wait-visible", selector: "#profile-list" });
    const selector = await browser.execute(
      profileName => `#profile-list [data-profile-name="${CSS.escape(profileName)}"] > button:first-child`,
      name,
    );
    const button = await select(selector);
    await button.waitForClickable();
    const clickedAt = await browser.execute(() => performance.now());
    await button.click();
    // Document click handlers can hide the menu immediately, and the label is
    // set before MIDI synchronization. Only this completed audit operation
    // confirms the load's initial flush and subsequent MIDI preference save.
    await browser.waitUntil(() => browser.execute(since => {
      const audit = window.__MIDIMASTER_PERF__;
      if (!audit?.enabled) throw new Error("Profile reload settlement requires an enabled performance audit");
      const operation = audit.snapshot().entries.find(entry =>
        entry.kind === "operation" && entry.name === "profile-midi-sync" &&
        Number.isFinite(entry.startTimeMs) && entry.startTimeMs >= since);
      if (!operation) return false;
      if (operation.ok !== true) throw new Error("Profile MIDI synchronization failed during audit setup");
      return true;
    }, clickedAt), { timeoutMsg: "Profile reload produced no fresh completed profile-midi-sync operation" });
    await runStep({ action: "wait-hidden", selector: "#profile-list" });
    await runStep({ action: "wait-text", selector: "#profile-current", value: name });
    await nextFrame();
    await nextFrame();
    return name;
  }

  async function resetJourneyUi(journeyId) {
    if (await (await select("#binding-config-panel")).isDisplayed()) {
      await runStep({ action: "click", selector: "#binding-config-cancel" });
      await runStep({ action: "wait-hidden", selector: "#binding-config-panel" });
    }
    await runStep({ action: "click", selector: "[data-page='bindings']" });
    await runStep({ action: "wait-visible", selector: "#main-screen" });
    // WebDriver's clear command need not produce the input event consumed by
    // the actual binding list. Dispatch it explicitly during unmeasured setup.
    await browser.execute(() => {
      const search = document.querySelector("#binding-search");
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await runStep({ action: "click", selector: "#binding-type-filter [data-filter='all']" });
    if (await (await select("#profile-list")).isDisplayed()) {
      await runStep({ action: "click", selector: "#profile-toggle" });
      await runStep({ action: "wait-hidden", selector: "#profile-list" });
    }
    if (journeyId === "density") {
      await runStep({ action: "click", selector: "#binding-density-toggle [data-density='comfortable']" });
      await runStep({
        action: "wait-attribute",
        selector: "#main-screen",
        name: "data-bindings-density",
        value: "comfortable",
      });
    }
    if (
      journeyId === "profile-switch" &&
      (await (await select("#profile-current")).getText()).trim() !== "Performance Default"
    ) {
      await runStep({ action: "click", selector: "#profile-toggle" });
      await runStep({ action: "wait-visible", selector: "#profile-list" });
      await runStep({
        action: "click",
        selector: "#profile-list [data-profile-name='Performance Default'] > button:first-child",
      });
      await runStep({ action: "wait-text", selector: "#profile-current", value: "Performance Default" });
      await runStep({ action: "wait-hidden", selector: "#profile-list" });
    }
    await nextFrame();
    await nextFrame();
  }

  return { nextFrame, runStep, resetJourneyUi, reloadCurrentProfile };
}
