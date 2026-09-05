import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { CdpSession, findTarget } from "../perf/capture-cdp.mjs";
import { renderFixture } from "./visual-fixture.mjs";
import { ROOT } from "./inventory.mjs";

// A local, isolated Edge profile exercises both revisions in the same renderer.
// This is a manual Windows check; it never starts Tauri or accesses connected devices.
const baseline =
  process.env.MIDIMASTER_VISUAL_BASELINE ||
  JSON.parse(await readFile(new URL("./baseline.json", import.meta.url), "utf8")).revision;
const output = resolve(process.env.MIDIMASTER_VISUAL_OUTPUT || "scripts/perf/.work/visual-equivalence");
const browserPath =
  process.env.MIDIMASTER_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = join(output, `edge-${Date.now()}`);
await mkdir(profile, { recursive: true });
const cache = new Map();
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = createServer(async (request, response) => {
  try {
    const match = /^\/(before|after)\/(src\/[\w./-]+)$/.exec(
      new URL(request.url, "http://localhost").pathname,
    );
    if (!match || match[2].includes("..")) {
      response.writeHead(404).end();
      return;
    }
    const [, variant, path] = match;
    const key = `${variant}/${path}`;
    if (!cache.has(key)) {
      let data =
        variant === "before"
          ? execFileSync("git", ["show", `${baseline}:${path}`], {
              cwd: ROOT,
              stdio: ["ignore", "pipe", "ignore"],
              maxBuffer: 20 * 1024 * 1024,
            })
          : await readFile(new URL(path, ROOT));
      if (path.endsWith(".html"))
        data = Buffer.from(data.toString("utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""));
      cache.set(key, data);
    }
    response
      .writeHead(200, {
        "Content-Type": mime[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(cache.get(key));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(
  browserPath,
  [
    "--headless",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let session;
const results = [];
try {
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(port, "Isolated Edge must expose a debugging port");
  const target = await findTarget(`http://127.0.0.1:${port}`, "about:blank", 10000);
  session = new CdpSession(target.webSocketDebuggerUrl);
  await session.open();
  const send = session.send.bind(session);
  session.send = (method, params) =>
    Promise.race([
      send(method, params),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 20000);
        timer.unref();
      }),
    ]);
  await session.send("Page.enable");
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  const cases = [];
  for (const theme of ["system", "dark", "light", "midnight", "ocean", "forest", "sunset"])
    for (const compact of [false, true]) cases.push({ theme, compact, view: "list" });
  for (const theme of ["dark", "light"])
    for (const view of ["fader", "button", "macro", "sound", "targets", "settings"])
      cases.push({ theme, view });
  for (const anchor of [
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ])
    cases.push({ view: "osd", anchor });
  for (const style of ["midnight", "glass", "neon", "studio"])
    cases.push({ view: "osd", anchor: "center", style });
  for (const [index, fixture] of cases.entries()) {
    const name = `${String(index + 1).padStart(2, "0")}-${fixture.view}-${fixture.theme || fixture.anchor}-${fixture.compact ? "compact" : fixture.style || "normal"}`;
    if (process.env.MIDIMASTER_VISUAL_FILTER && !name.includes(process.env.MIDIMASTER_VISUAL_FILTER))
      continue;
    const images = [];
    for (const variant of ["before", "after"]) {
      const loaded = session.once("Page.loadEventFired");
      await session.send("Page.navigate", {
        url: `${origin}/${variant}/src/${fixture.view === "osd" ? "osd" : "index"}.html`,
      });
      await loaded;
      const result = await session.send("Runtime.evaluate", {
        expression: `(${renderFixture.toString()})(${JSON.stringify({ ...fixture, variant })})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          `${name} ${variant}: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`,
        );
      await writeFile(join(output, `${name}-${variant}.json`), JSON.stringify(result.result.value, null, 2));
      const shot = await session.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      images.push(Buffer.from(shot.data, "base64"));
      await writeFile(join(output, `${name}-${variant}.png`), images.at(-1));
    }
    const identical = images[0].equals(images[1]);
    results.push({ name, identical });
    console.log(`${identical ? "PASS" : "DIFF"} ${name}`);
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ baseline, cases: results }, null, 2) + "\n");
  assert.ok(
    results.every((result) => result.identical),
    "Before/after screenshots differ; inspect the saved images",
  );
  console.log(`All ${results.length} screenshot pairs are byte-identical. Artifacts: ${output}`);
} finally {
  if (session) {
    await session.send("Browser.close").catch(() => {});
    session.close();
  }
  browser.kill();
  server.close();
}
