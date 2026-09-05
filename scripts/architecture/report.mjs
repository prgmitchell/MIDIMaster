import { inventory } from "./inventory.mjs";
import { readFile, writeFile } from "node:fs/promises";
const baseline = JSON.parse(await readFile(new URL("./baseline.json", import.meta.url), "utf8"));
const before = await inventory(baseline.revision),
  after = await inventory();
const changes = Object.fromEntries(
  Object.keys(after.totals).map((key) => [
    key,
    { before: before.totals[key], after: after.totals[key], delta: after.totals[key] - before.totals[key] },
  ]),
);
const oversized = after.files
  .filter((f) => ["frontend", "rust", "plugins"].includes(f.category) && f.implementationLines > 600)
  .sort((a, b) => b.implementationLines - a.implementationLines);
const report = {
  baselineRevision: before.revision,
  authoredProduction: {
    before: before.authoredProduction,
    after: after.authoredProduction,
    delta: after.authoredProduction - before.authoredProduction,
  },
  categories: changes,
  oversized,
};
if (process.argv.includes("--write"))
  await writeFile(
    new URL("./refactor-metrics.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
console.log(JSON.stringify(report, null, 2));
