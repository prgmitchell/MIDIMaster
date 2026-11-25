import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./desktop.mjs";

async function announceUpdate(app) {
  await app.eval(`window.__TAURI__.event.emit('updater_status', {
    phase: 'available', current_version: '1.0.0', version: '1.1.0'
  })`);
  await app.shown("#topbar-update-button");
}

async function openReleaseDialog(app, responseCode = 200) {
  const release = {
    tag_name: "v1.1.0",
    body: "- Updated **volume controls**.\n\n[Full changelog](https://github.com/prgmitchell/MIDIMaster/compare/v1.0.0...v1.1.0)",
  };
  await app.session.send("Fetch.enable", {
    patterns: [
      {
        urlPattern:
          "https://api.github.com/repos/prgmitchell/MIDIMaster/releases/tags/v1.1.0",
      },
    ],
  });
  try {
    const response = app.session
      .once("Fetch.requestPaused", 10000)
      .then(({ requestId }) =>
        app.session.send("Fetch.fulfillRequest", {
          requestId,
          responseCode,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: Buffer.from(JSON.stringify(release)).toString("base64"),
        }),
      );
    await Promise.all([response, app.click("#topbar-update-button")]);
    await app.shown('.release-notes[aria-busy="false"]');
  } finally {
    await app.session.send("Fetch.disable");
  }
}

async function installAttempts(app) {
  return app.eval(`window.__MIDIMASTER_PERF__.snapshot().entries.filter(
    e => e.kind === 'ipc' && e.name === 'download_and_install_update'
  ).length`);
}

export const updater = [
  [
    "update dialog shows GitHub release notes and dismisses or skips without installing",
    async (app) => {
      await app.click('.sidebar-nav-item[data-page="bindings"]');
      await announceUpdate(app);
      const before = await installAttempts(app);
      await openReleaseDialog(app);
      assert.match(
        await app.query("#release-title", "e.textContent"),
        /1\.1\.0/,
      );
      assert.equal(
        await app.query(".release-notes", "e.querySelectorAll('li').length"),
        1,
      );
      assert.equal(
        await app.query(".release-notes strong", "e.textContent"),
        "volume controls",
      );
      assert.equal(
        await app.query(".release-link", "e.href"),
        "https://github.com/prgmitchell/MIDIMaster/compare/v1.0.0...v1.1.0",
      );
      await app.click(".release-close");
      await app.hidden(".release-dialog");
      assert.equal(await installAttempts(app), before);
      await app.click("#topbar-update-button");
      await app.click(".release-skip");
      await app.hidden(".release-dialog");
      assert.equal(
        await app.eval("localStorage.getItem('updaterSkippedVersion')"),
        "1.1.0",
      );
      assert.equal(await installAttempts(app), before);
      assert.equal(await app.visible('[data-page-panel="bindings"]'), true);
      await app.eval("localStorage.removeItem('updaterSkippedVersion')");
    },
  ],
  [
    "update dialog installation exposes failures and recovery controls",
    async (app) => {
      // The native offline mode rejects installation without downloading or
      // replacing the app. Only the available-update announcement is synthetic.
      await app.stop();
      await app.start();
      await app.click('.sidebar-nav-item[data-page="settings"]');
      await app.click('[data-settings-section="appearance"]');
      await app.click('.sidebar-nav-item[data-page="bindings"]');
      await announceUpdate(app);
      const before = await installAttempts(app);
      await openReleaseDialog(app, 503);
      assert.match(
        await app.query(".release-notes", "e.textContent"),
        /unavailable/,
      );
      assert.equal(
        await app.query(".release-link", "e.href"),
        "https://github.com/prgmitchell/MIDIMaster/releases/tag/v1.1.0",
      );
      await app.click(".release-install");
      await app.hidden(".release-dialog");
      await eventually(
        async () => (await installAttempts(app)) === before + 1,
        "one native install attempt",
      );
      await eventually(
        () =>
          app.query("#settings-update-status", "e.classList.contains('error')"),
        "installation failure reported",
      );
      assert.match(
        await app.query("#settings-update-status", "e.textContent"),
        /Unable to reach update server/,
      );
      await app.shown("#settings-update-status");
      assert.equal(
        await app.query(
          "#settings-update-status",
          `(() => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })()`,
        ),
        true,
        "the error is in view without scrolling",
      );
      assert.equal(await app.query("#check-for-updates", "e.disabled"), false);
      assert.equal(await app.visible("#topbar-update-button"), false);
      await app.screenshot("update-install-failure");
      await app.click("#check-for-updates");
      await eventually(
        () =>
          app.query(
            "#settings-update-status",
            "e.classList.contains('success')",
          ),
        "update check can be retried",
      );
      await app.click('.sidebar-nav-item[data-page="bindings"]');
    },
  ],
  [
    "updater events display download progress and network errors",
    async (app) => {
      await announceUpdate(app);
      await app.click('.sidebar-nav-item[data-page="settings"]');
      await app.click('[data-settings-section="startup"]');
      const status = "#settings-update-status";
      await app.query(
        status,
        "e.scrollIntoView({ block: 'center', behavior: 'instant' })",
      );
      const emitStatus = (payload) =>
        app.eval(
          `window.__TAURI__.event.emit('updater_status', ${JSON.stringify(payload)})`,
        );
      await emitStatus({
        phase: "downloading",
        downloaded: 25,
        content_length: 100,
      });
      await eventually(
        async () => (await app.query(status, "e.textContent")).includes("25%"),
        "download progress reaches the settings UI",
      );
      assert.equal(await app.query("#check-for-updates", "e.disabled"), true);
      await emitStatus({ phase: "downloaded" });
      await eventually(
        async () => /Installing/.test(await app.query(status, "e.textContent")),
        "installation progress reaches the settings UI",
      );
      await emitStatus({
        phase: "failed",
        message:
          "Update check failed: HTTP 504 Gateway Timeout (https://updates.midimaster.app/latest.json)",
      });
      await eventually(
        () => app.query(status, "e.classList.contains('error')"),
        "network failure reaches the settings UI",
      );
      assert.equal(await app.query("#check-for-updates", "e.disabled"), false);
      assert.match(
        await app.query(status, "e.textContent"),
        /Unable to reach update server right now\. Try again in a moment\./,
      );
      await app.query(
        status,
        "Promise.all(e.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))",
      );
      await app.screenshot("update-network-error");
      const clip = await app.query(
        ".settings-update-card",
        `(() => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 };
      })()`,
      );
      const { data } = await app.session.send("Page.captureScreenshot", {
        clip,
      });
      await writeFile(
        join(app.root, "artifacts", "update-network-error-detail.png"),
        Buffer.from(data, "base64"),
      );
      await app.click('.sidebar-nav-item[data-page="bindings"]');
    },
  ],
];
