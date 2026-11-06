import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { CdpSession, findTarget } from "../perf/capture-cdp.mjs";
import { createProfilesFixture } from "../perf/generate-fixtures.mjs";

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function eventually(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${message}`);
}

export async function build() {
  const config = await readFile("src-tauri/tauri.e2e.conf.json", "utf8");
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      "cargo",
      [
        "build",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--features",
        "e2e",
        "--locked",
      ],
      {
        windowsHide: true,
        stdio: "inherit",
        env: { ...process.env, TAURI_CONFIG: config },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`E2E build failed (${code})`)),
    );
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((r, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", r);
  });
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

export class Desktop {
  constructor(root) {
    this.root = resolve(root);
    this.data = join(this.root, "app-data", "MIDIMaster");
    this.errors = [];
    this.logs = [];
  }
  async prepare() {
    for (const dir of [
      this.data,
      "webview",
      "roaming",
      "local",
      "temp",
      "artifacts",
    ].map((p) => resolve(this.root, p))) {
      await mkdir(dir, { recursive: true });
    }
    await this.json("fixture.json", { synthetic_only: true });
    const { profiles } = createProfilesFixture({
      bindingCount: 50,
      profileCount: 2,
      shape: "light",
    });
    await writeFile(join(this.data, "profiles.json"), JSON.stringify(profiles));
    await writeFile(
      join(this.data, "app_settings.json"),
      JSON.stringify({
        active_profile_name: "Performance Default",
        auto_check_updates: false,
        midi_device_inventory_consent: "disabled",
        midi_device_inventory_notice_version: 1,
        startup_registration_version: 2,
        start_with_windows: false,
        start_in_tray: false,
        exit_to_tray: false,
        minimize_to_tray: false,
        language: "en",
      }),
    );
  }
  async json(name, value) {
    await writeFile(join(this.root, name), JSON.stringify(value, null, 2));
  }
  async chooseFile(path) {
    await writeFile(join(this.data, "e2e-dialog.json"), JSON.stringify(path));
  }
  async start(networkMode = "offline") {
    const port = await availablePort();
    this.endpoint = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      MIDIMASTER_PERF_APP_DATA_DIR: this.data,
      MIDIMASTER_PERF_WEBVIEW_DATA_DIR: join(this.root, "webview"),
      MIDIMASTER_E2E_CDP_PORT: String(port),
      MIDIMASTER_PERF_RESULTS_DIR: join(this.root, "artifacts"),
      MIDIMASTER_PERF_RUN_ID: "e2e",
      MIDIMASTER_PERF_NETWORK_MODE: networkMode,
      MIDIMASTER_PERF_SYNTHETIC_TARGETS: "1",
      APPDATA: join(this.root, "roaming"),
      LOCALAPPDATA: join(this.root, "local"),
      TEMP: join(this.root, "temp"),
      TMP: join(this.root, "temp"),
    };
    this.child = spawn(resolve("src-tauri/target/debug/midimaster.exe"), [], {
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.output = "";
    for (const stream of [this.child.stdout, this.child.stderr])
      stream.on("data", (data) => {
        this.output = (this.output + data).slice(-100000);
      });
    const exited = new Promise((_, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code) =>
        reject(new Error(`Desktop exited (${code}): ${this.output}`)),
      );
    });
    exited.catch(() => {});
    const target = await Promise.race([
      findTarget(this.endpoint, "index.html", 60000),
      exited,
    ]);
    this.session = new CdpSession(target.webSocketDebuggerUrl);
    await this.session.open();
    this.session.on("Runtime.exceptionThrown", (e) =>
      this.errors.push(
        e.exceptionDetails?.exception?.description || e.exceptionDetails?.text,
      ),
    );
    await this.session.send("Runtime.enable");
    const { width, height } = JSON.parse(
      await readFile("src-tauri/tauri.e2e.conf.json", "utf8"),
    ).app.windows[0];
    // Hosted Windows desktops can clamp native windows below the app's minimum
    // size. Keep the real WebView's test viewport consistent with its config.
    await this.session.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.json(
      "viewport.json",
      await this.eval(
        "({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })",
      ),
    );
    await eventually(
      () =>
        this.eval(
          "window.__MIDIMASTER_PERF__?.snapshot().entries.some(e => e.name === 'bindings-usable')",
        ),
      "app startup",
      60000,
    );
    assert.equal(
      resolve(await this.invoke("get_plugins_dir")),
      join(this.data, "plugins"),
    );
    assert.equal(
      (await this.invoke("perf_audit_snapshot")).synthetic_targets_enabled,
      true,
    );
    await this.eval(`(() => {
      window.__e2eInteractions = [];
      const record = entry => { window.__e2eInteractions.push({ at: performance.now(), ...entry }); if (window.__e2eInteractions.length > 200) window.__e2eInteractions.shift(); };
      for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, e => record({ type, id: e.target.id, page: e.target.closest('[data-page]')?.dataset.page, inert: Boolean(document.querySelector('#app-shell')?.inert) }), true);
      new MutationObserver(entries => entries.forEach(e => record({ type: 'inert', id: e.target.id, value: e.target.inert }))).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['inert'] });
    })()`);
  }
  async eval(expression) {
    const result = await this.session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result?.value;
  }
  invoke(command, args = {}) {
    return this.eval(
      `window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).catch(error => { throw new Error(typeof error === 'string' ? error : JSON.stringify(error)); })`,
    );
  }
  query(selector, expression) {
    return this.eval(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return ${expression}; })()`,
    );
  }
  visible(selector) {
    return this.query(
      selector,
      "Boolean(e && !e.closest('.hidden,[hidden]') && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')",
    );
  }
  async shown(selector) {
    await eventually(() => this.visible(selector), `visible ${selector}`);
  }
  async hidden(selector) {
    await eventually(
      async () => !(await this.visible(selector)),
      `hidden ${selector}`,
    );
  }
  async click(selector) {
    await this.shown(selector);
    await this.query(
      selector,
      "e.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'})",
    );
    let point, previous;
    await eventually(async () => {
      point = await this.query(
        selector,
        `(() => {
        if (!e || e.disabled || e.closest('[inert]')) return null;
        const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
        return e.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
      })()`,
      );
      const stable =
        point && previous && point.x === previous.x && point.y === previous.y;
      previous = point;
      return stable;
    }, `stable, unobstructed ${selector}`);
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
    });
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await this.eval(
      "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
    );
  }
  async key(key, code, modifiers = 0) {
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      windowsVirtualKeyCode: code,
      modifiers,
    });
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      windowsVirtualKeyCode: code,
      modifiers,
    });
  }
  async drag(source, destination) {
    await this.shown(source);
    await this.shown(destination);
    await this.query(
      destination,
      "e.scrollIntoView({block:'nearest', behavior:'instant'})",
    );
    const position = (selector) =>
      this.query(
        selector,
        "(() => { const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()",
      );
    const from = await position(source),
      to = await position(destination);
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...from,
    });
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...from,
    });
    for (let i = 1; i <= 12; i++) {
      await this.session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        button: "left",
        buttons: 1,
        x: from.x + ((to.x - from.x) * i) / 12,
        y: from.y + ((to.y - from.y) * i) / 12,
      });
      await pause(20);
    }
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...to,
    });
  }
  async select(selector, value) {
    const option = await this.query(
      selector,
      `Array.from(e.options).filter(o => o.value).findIndex(o => o.value === ${JSON.stringify(value)})`,
    );
    assert.ok(option >= 0, `Missing option ${value} in ${selector}`);
    await this.click(`${selector} + .target-dropdown > button`);
    await this.click(
      `${selector} + .target-dropdown .target-option:nth-child(${option + 1})`,
    );
    assert.equal(await this.query(selector, "e.value"), value);
  }
  async clickText(selector, text) {
    await eventually(
      () =>
        this.eval(
          `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e => e.textContent.trim() === ${JSON.stringify(text)} && !e.closest('.hidden,[hidden]'))`,
        ),
      `text ${text}`,
    );
    const selected = await this.eval(`(() => {
      const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      return all.findIndex(e => e.textContent.trim() === ${JSON.stringify(text)} && !e.closest('.hidden,[hidden]'));
    })()`);
    // Attach a temporary selector to the observed node; activation still uses real pointer input.
    await this.eval(
      `document.querySelectorAll(${JSON.stringify(selector)})[${selected}].setAttribute('data-e2e-hit','true')`,
    );
    try {
      await this.click('[data-e2e-hit="true"]');
    } finally {
      await this.eval(
        "document.querySelector('[data-e2e-hit]')?.removeAttribute('data-e2e-hit')",
      );
    }
  }
  async fill(selector, value) {
    await this.click(selector);
    await this.key("a", 65, 2);
    if (value) await this.session.send("Input.insertText", { text: value });
    else await this.key("Backspace", 8);
  }
  async screenshot(name) {
    const { data } = await this.session.send("Page.captureScreenshot");
    await writeFile(
      join(this.root, "artifacts", `${name}.png`),
      Buffer.from(data, "base64"),
    );
  }
  async stop() {
    this.session?.close();
    if (this.child && this.child.exitCode === null) {
      const child = this.child;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill(); // Only the process launched by this harness, never an installed app.
      await Promise.race([exited, pause(5000)]);
    }
    if (this.loggedChild !== this.child) {
      this.logs.push(this.output || "");
      this.loggedChild = this.child;
    }
    await writeFile(
      join(this.root, "artifacts", "backend.log"),
      this.logs.join("\n"),
    );
  }
}
