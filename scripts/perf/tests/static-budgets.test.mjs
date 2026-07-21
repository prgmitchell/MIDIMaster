import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkStaticBudgets } from "../check-static-budgets.mjs";

const config = {
  entries: [
    { name: "main", html: "src/index.html", allowed_modules: ["main.js"], forbidden_modules: ["osd.js", "update.js"] },
    { name: "osd", html: "src/osd.html", allowed_modules: ["osd.js"], forbidden_modules: ["main.js", "update.js"] },
    { name: "update", html: "src/update.html", allowed_modules: ["update.js"], forbidden_modules: ["main.js", "osd.js"] },
  ],
  initial_images: { html: "src/index.html", maximum_total_bytes: 100, maximum_single_bytes: 100, maximum_eager_theme_logos: 1 },
  maximum_frontend_file_bytes: 1000,
};

test("static guard enforces distinct entries and eager image budgets", async () => {
  const root = await mkdtemp(join(tmpdir(), "midimaster-static-test-"));
  try {
    await mkdir(join(root, "src", "assets"), { recursive: true });
    await writeFile(join(root, "src", "index.html"), '<img class="app-logo" src="assets/logo.png"><script type="module" src="main.js"></script>');
    await writeFile(join(root, "src", "osd.html"), '<script type="module" src="osd.js"></script>');
    await writeFile(join(root, "src", "update.html"), '<script type="module" src="update.js"></script>');
    await writeFile(join(root, "src", "assets", "logo.png"), Buffer.alloc(80));
    assert.deepEqual(await checkStaticBudgets({ root, config }), []);

    await writeFile(join(root, "src", "osd.html"), '<script type="module" src="main.js"></script>');
    const failures = await checkStaticBudgets({ root, config });
    assert.ok(failures.some((message) => message.includes("forbidden shared startup module")));
    assert.ok(failures.some((message) => message.includes("multiple window entries")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
