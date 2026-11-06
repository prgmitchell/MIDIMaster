import { resolve } from "node:path";
import { Desktop, build } from "./desktop.mjs";
import { scenarios } from "./scenarios.mjs";

if (process.platform !== "win32")
  throw new Error("MIDIMaster desktop E2E requires Windows and WebView2");
await build();
const app = new Desktop(resolve("test-results", `desktop-${Date.now()}`));
await app.prepare();
const results = [];
const filterIndex = process.argv.indexOf("--filter");
const selected =
  filterIndex < 0
    ? scenarios
    : scenarios.filter(([name]) =>
        new RegExp(process.argv[filterIndex + 1], "i").test(name),
      );
if (!selected.length) throw new Error("No E2E scenarios matched the filter");
try {
  await app.start();
  for (const [name, run] of selected) {
    const started = performance.now();
    try {
      await run(app);
      results.push({
        name,
        status: "passed",
        duration_ms: performance.now() - started,
      });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, status: "failed", error: error.stack });
      await app.screenshot("failure").catch(() => {});
      await app.json(
        "failure-dom.json",
        await app
          .eval("document.body.innerText")
          .catch(() => "Desktop unavailable"),
      );
      await app.json(
        "failure-html.json",
        await app
          .eval("document.documentElement.outerHTML")
          .catch(() => "Desktop unavailable"),
      );
      await app.json(
        "failure-input.json",
        await app.eval("window.__e2eInteractions").catch(() => []),
      );
      throw error;
    }
  }
  if (app.errors.length)
    throw new Error(`Uncaught renderer errors: ${app.errors.join("\n")}`);
  await app.screenshot("completed");
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await app.json("results.json", { results, renderer_errors: app.errors });
  await app.stop();
  console.log(`Desktop evidence: ${app.root}`);
}
