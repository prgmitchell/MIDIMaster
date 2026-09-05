import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export const ROOT = new URL("../../", import.meta.url);
export function git(args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export function sourceFiles(revision) {
  return (
    revision
      ? git(["ls-tree", "-r", "--name-only", revision])
      : git(["ls-files", "--cached", "--others", "--exclude-standard"])
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(
      (file) =>
        /\.(?:js|mjs|rs|css|html|ps1|json)$/.test(file) &&
        !/package-lock\.json$|\/locales\/|scripts\/architecture\/.*\.json$/.test(file),
    );
}
const lines = (source) =>
  source ? source.replace(/\r\n/g, "\n").split("\n").length - Number(source.endsWith("\n")) : 0;
export function classify(file, source) {
  if (file.startsWith("scripts/fixtures/")) return "fixtures";
  if (
    file.startsWith("scripts/test-") ||
    file.includes("/tests/") ||
    /\/(?:tests|test_support|compatibility_tests)\.rs$/.test(file)
  )
    return "tests";
  if (/\/builtin_plugins\/[^/]+\/plugin\.mjs$/.test(file))
    return source.startsWith("// Generated") ? "generated" : "plugins";
  if (
    (file.includes("/builtin_plugins/") && file.endsWith(".js")) ||
    file.startsWith("src-tauri/plugin_sources/")
  )
    return "plugins";
  if (file.startsWith("src/") && (/\.(?:css|html)$/.test(file) || file.endsWith("/template.js")))
    return "declarative";
  if (file.startsWith("src/") && file.endsWith(".js")) return "frontend";
  if (/^(?:src-tauri\/src\/|virtual-audio\/)/.test(file) && file.endsWith(".rs")) return "rust";
  if (file.startsWith("scripts/") || file.endsWith("/build.rs")) return "tooling";
  return "configuration";
}
export async function inventory(revision = null) {
  const totals = {
    frontend: 0,
    rust: 0,
    plugins: 0,
    declarative: 0,
    tests: 0,
    fixtures: 0,
    generated: 0,
    tooling: 0,
    configuration: 0,
  };
  const files = [];
  for (const file of sourceFiles(revision)) {
    const source = revision
      ? git(["show", `${revision}:${file}`])
      : await readFile(new URL(file, ROOT), "utf8");
    const category = classify(file, source);
    const total = lines(source);
    // Rust keeps many tests inline. Separate the trailing test module rather than treating it as production.
    const marker =
      category === "rust"
        ? source.search(/#\[cfg\(test\)\]\s*(?:#\[path[^\n]+\]\s*)?mod (?:tests|batch_tests)\s*\{/)
        : -1;
    const testLines = marker < 0 ? 0 : lines(source.slice(marker));
    totals[category] += total - testLines;
    totals.tests += testLines;
    files.push({ file, category, lines: total, implementationLines: total - testLines });
  }
  return {
    revision: revision || git(["rev-parse", "HEAD"]).trim(),
    totals,
    authoredProduction: totals.frontend + totals.rust + totals.plugins,
    files,
  };
}
