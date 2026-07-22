import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { localeCodes, targetLocales } from "../../src/app/locales.js";

const root = process.cwd();
const localeDir = path.join(root, "src", "locales");
const locales = targetLocales.map((locale) => locale.code);
const sourceScanRoots = [
  path.join(root, "src", "app"),
  path.join(root, "src", "features"),
];
const sourceScanFiles = [
  path.join(root, "src", "app_entry.js"),
  path.join(root, "src", "index.html"),
];

function placeholders(value) {
  return Array.from(String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g))
    .map((match) => match[1])
    .sort();
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function collectFiles(dir, files = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(filePath, files);
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".html")) {
      files.push(filePath);
    }
  }));
  return files;
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isAllowedIdenticalEnglish(key, value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (/^(MIDIMaster|OBS|Hue|Wave Link|OK|OSD|MIDI|MAIN|v\{version\}|\.exe)$/i.test(text)) return true;
  if (/^[0-9\s%/.:{}()_-]+$/.test(text)) return true;
  if (key.startsWith("plugins.category.")) return true;
  if (key.startsWith("targets.action.media")) return true;
  return false;
}

async function validateLocaleSync() {
  const i18n = await fs.readFile(path.join(root, "src", "app", "locales.js"), "utf8");
  const rust = await fs.readFile(path.join(root, "src-tauri", "src", "commands", "settings.rs"), "utf8");
  const frontendCodes = Array.from(i18n.matchAll(/code:\s*"([^"]+)"/g)).map((match) => match[1]);
  const rustCodes = Array.from(rust.matchAll(/"([^"]+)"/g))
    .map((match) => match[1])
    .filter((value) => localeCodes().includes(value));
  const expected = localeCodes();
  const uniqueRustCodes = Array.from(new Set(rustCodes));
  if (JSON.stringify(frontendCodes) !== JSON.stringify(expected)) {
    console.error(`[i18n] frontend locale list is out of sync: expected ${expected.join(", ")}, got ${frontendCodes.join(", ")}`);
    return false;
  }
  if (JSON.stringify(uniqueRustCodes) !== JSON.stringify(expected)) {
    console.error(`[i18n] Rust language normalization is out of sync: expected ${expected.join(", ")}, got ${uniqueRustCodes.join(", ")}`);
    return false;
  }
  return true;
}

async function findUsedTranslationKeys() {
  const files = [
    ...sourceScanFiles,
    ...(await Promise.all(sourceScanRoots.map((dir) => collectFiles(dir)))).flat(),
  ];
  const uniqueFiles = Array.from(new Set(files));
  const used = new Map();
  for (const filePath of uniqueFiles) {
    let source = "";
    try {
      source = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const patterns = [
      /\bt\(\s*["']([^"']+)["']/g,
      /data-i18n(?:-[\w-]+)?=["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        const key = match[1];
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        if (!used.has(key)) used.set(key, []);
        used.get(key).push(`${path.relative(root, filePath).replaceAll("\\", "/")}:${line}`);
      }
    }
  }
  return used;
}

async function validateUsedKeys(english) {
  const used = await findUsedTranslationKeys();
  let ok = true;
  for (const [key, locations] of Array.from(used.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Object.prototype.hasOwnProperty.call(english, key)) {
      console.error(`[i18n] missing English source key "${key}" used at ${locations.slice(0, 3).join(", ")}`);
      ok = false;
    }
  }
  return ok;
}

const english = await readJson(path.join(localeDir, "en.json"));
const englishKeys = Object.keys(english).sort();
let failed = false;
if (!(await validateLocaleSync())) {
  failed = true;
}
if (!(await validateUsedKeys(english))) {
  failed = true;
}

for (const locale of locales) {
  const filePath = path.join(localeDir, `${locale}.json`);
  let catalog;
  try {
    catalog = await readJson(filePath);
  } catch (error) {
    console.error(`[i18n] ${locale}: cannot read ${filePath}: ${error.message}`);
    failed = true;
    continue;
  }

  const keys = Object.keys(catalog).sort();
  const extra = keys.filter((key) => !Object.prototype.hasOwnProperty.call(english, key));
  if (extra.length > 0) {
    console.error(`[i18n] ${locale}: extra keys: ${extra.join(", ")}`);
    failed = true;
  }

  const untranslatedFallbacks = [];
  for (const key of englishKeys) {
    if (!Object.prototype.hasOwnProperty.call(catalog, key)) continue;
    const expected = placeholders(english[key]);
    const actual = placeholders(catalog[key]);
    if (!sameArray(expected, actual)) {
      console.error(`[i18n] ${locale}: placeholder mismatch for ${key}: expected {${expected.join(",")}}, got {${actual.join(",")}}`);
      failed = true;
    }
    if (
      String(catalog[key]) === String(english[key])
      && !isAllowedIdenticalEnglish(key, english[key])
    ) {
      untranslatedFallbacks.push(key);
    }
  }
  const fallbackRatio = untranslatedFallbacks.length / Math.max(1, keys.length);
  if (fallbackRatio > 0.2) {
    console.error(`[i18n] ${locale}: too many untranslated English fallbacks (${untranslatedFallbacks.length}/${englishKeys.length}): ${untranslatedFallbacks.join(", ")}`);
    failed = true;
  } else if (untranslatedFallbacks.length > 0) {
    console.warn(`[i18n] ${locale}: ${untranslatedFallbacks.length} strings are identical to English; below failure threshold.`);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`[i18n] validated ${locales.length + 1} locale catalogs.`);
