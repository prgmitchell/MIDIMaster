import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";
import { analyze } from "eslint-scope";
import { inventory, ROOT } from "./inventory.mjs";

const limits = JSON.parse(await readFile(new URL("./module-limits.json", import.meta.url), "utf8"));
const current = await inventory();
const failures = [];
const browserGlobals = new Set(
  "undefined NaN Infinity console globalThis window document navigator performance localStorage sessionStorage location setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask fetch URL URLSearchParams Blob File FileReader FormData Headers Request Response AbortController AbortSignal Event CustomEvent MouseEvent KeyboardEvent PointerEvent HTMLElement Element Node Image Audio ResizeObserver MutationObserver IntersectionObserver PerformanceObserver CSS getComputedStyle TextEncoder TextDecoder WebSocket atob btoa crypto structuredClone alert confirm prompt setImmediate clearImmediate process Buffer JSON Math Date String Number Boolean Object Array Set Map WeakSet WeakMap Promise Error TypeError RangeError RegExp Symbol Reflect Intl BigInt parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape Uint8Array Uint16Array Uint32Array Int8Array Int16Array Int32Array Float32Array Float64Array ArrayBuffer DataView SharedArrayBuffer Atomics DOMParser XMLSerializer HTMLInputElement HTMLSelectElement HTMLCanvasElement EventTarget".split(
    " ",
  ),
);
const startupModules = new Set([
  "src/main.js",
  "src/app_entry.js",
  "src/app/application.js",
  "src/app/controllers/startup.js",
]);

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (value && typeof value === "object" && value.type) walk(value, visit);
  }
}

for (const entry of current.files) {
  if (!["frontend", "rust", "plugins"].includes(entry.category)) continue;
  const exception = limits.exceptions[entry.file];
  const maximum = exception?.maxLines ?? limits.defaultMaxLines;
  if (entry.implementationLines > maximum)
    failures.push(`${entry.file}: ${entry.implementationLines} implementation lines exceeds ${maximum}`);
  if (!entry.file.endsWith(".js")) continue;
  const source = await readFile(new URL(entry.file, ROOT), "utf8");
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", ranges: true, locations: true });
  const scopes = analyze(tree, {
    ecmaVersion: 2024,
    sourceType: "module",
    optimistic: true,
    ignoreEval: true,
  });
  const unknown = new Set(
    scopes.globalScope.through.map((ref) => ref.identifier.name).filter((name) => !browserGlobals.has(name)),
  );
  if (unknown.size) failures.push(`${entry.file}: unresolved globals: ${[...unknown].join(", ")}`);
  if (!entry.file.startsWith("src/features/")) continue;
  walk(tree, (node) => {
    const specifier =
      node.type === "ImportExpression"
        ? node.source?.value
        : ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
          ? node.source?.value
          : null;
    if (typeof specifier !== "string" || !specifier.startsWith(".")) return;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.file), specifier));
    if (startupModules.has(target))
      failures.push(`${entry.file}:${node.loc.start.line}: features cannot import startup (${target})`);
  });
}
for (const [file, exception] of Object.entries(limits.exceptions)) {
  assert.ok(exception.reason?.trim().length > 30, `${file}: explain why this module exceeds 600 lines`);
  if (!current.files.some((entry) => entry.file === file))
    failures.push(`${file}: remove obsolete size exception`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Architecture checks passed (${Object.keys(limits.exceptions).length} documented, bounded size exceptions).`,
  );
