import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = new URL("./", import.meta.url);
const testFiles = (await readdir(scriptsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^test-.*\.mjs$/u.test(entry.name))
  .map((entry) => entry.name)
  .sort();

for (const testFile of testFiles) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(testFile, scriptsDirectory))], {
    cwd: fileURLToPath(new URL("../", scriptsDirectory)),
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`All ${testFiles.length} frontend test scripts passed`);
