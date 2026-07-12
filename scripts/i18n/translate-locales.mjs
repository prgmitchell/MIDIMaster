import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { supportedLocales, targetLocales } from "../../src/app/locales.js";
const root = process.cwd();
const localeDir = path.join(root, "src", "locales");
const metaPath = path.join(localeDir, ".i18n-meta.json");
const locales = targetLocales.map((locale) => locale.code);
const localeByCode = new Map(supportedLocales.map((locale) => [locale.code, locale]));

const provider = String(process.env.I18N_PROVIDER || "libretranslate").trim().toLowerCase();
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
const skipReadiness = process.argv.includes("--skip-readiness-check");
const failOnPending = process.argv.includes("--fail-on-pending");

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function placeholders(value) {
  return Array.from(String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)).map((match) => match[0]);
}

function maskPlaceholders(value) {
  const original = String(value ?? "");
  const tokens = placeholders(original);
  let masked = original;
  tokens.forEach((token, index) => {
    masked = masked.replaceAll(token, `ZXQ${index}QXZ`);
  });
  return { masked, tokens };
}

function restorePlaceholders(value, tokens) {
  let restored = String(value ?? "");
  tokens.forEach((token, index) => {
    const marker = `ZXQ${index}QXZ`;
    restored = restored
      .replaceAll(marker, token)
      .replaceAll(marker.toLowerCase(), token)
      .replaceAll(`ZXQ ${index} QXZ`, token)
      .replaceAll(`ZXQ${index}`, token);
  });
  return restored;
}

function normalizeLibreTarget(locale) {
  return localeByCode.get(locale)?.libreTarget || locale;
}

function normalizeArgosTarget(locale) {
  return localeByCode.get(locale)?.libreTarget || locale;
}

async function translateTextWithLibreTranslate(locale, text) {
  const url = String(process.env.LIBRETRANSLATE_URL || "http://127.0.0.1:5000").replace(/\/+$/, "");
  const apiKey = process.env.LIBRETRANSLATE_API_KEY || "";
  const response = await fetch(`${url}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: text,
      source: "en",
      target: normalizeLibreTarget(locale),
      format: "text",
      ...(apiKey ? { api_key: apiKey } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`LibreTranslate failed for ${locale}: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return String(data.translatedText ?? "");
}

async function translateWithLibreTranslate(locale, entries) {
  const translated = {};
  for (const [key, value] of Object.entries(entries)) {
    const { masked, tokens } = maskPlaceholders(value);
    translated[key] = restorePlaceholders(await translateTextWithLibreTranslate(locale, masked), tokens);
  }
  return translated;
}

async function assertLibreTranslateReady() {
  if (skipReadiness) return;
  const url = String(process.env.LIBRETRANSLATE_URL || "http://127.0.0.1:5000").replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${url}/languages`);
  } catch (error) {
    throw new Error(`LibreTranslate is not reachable at ${url}. Run scripts/i18n/bootstrap-libretranslate.ps1 first, or set LIBRETRANSLATE_URL. ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`LibreTranslate readiness check failed at ${url}/languages: ${response.status} ${await response.text()}`);
  }
  const languages = await response.json();
  const codes = new Set((Array.isArray(languages) ? languages : []).map((language) => String(language.code || "")));
  const missing = locales
    .map((locale) => normalizeLibreTarget(locale))
    .filter((target) => target !== "en" && !codes.has(target));
  if (missing.length > 0) {
    throw new Error(`LibreTranslate is missing target language models: ${Array.from(new Set(missing)).join(", ")}. Restart it with --update-models.`);
  }
}

async function translateWithArgos(locale, entries) {
  const python = process.env.ARGOS_PYTHON || process.env.PYTHON || "python";
  const target = normalizeArgosTarget(locale);
  const script = String.raw`
import json
import sys

try:
    import argostranslate.package
    import argostranslate.translate
except Exception as exc:
    print(json.dumps({"error": "argostranslate is not installed: %s" % exc}), file=sys.stderr)
    sys.exit(2)

payload = json.loads(sys.stdin.read())
target = payload["target"]
entries = payload["entries"]

argostranslate.package.update_package_index()
installed = argostranslate.package.get_installed_packages()
if not any(pkg.from_code == "en" and pkg.to_code == target for pkg in installed):
    available = argostranslate.package.get_available_packages()
    match = next((pkg for pkg in available if pkg.from_code == "en" and pkg.to_code == target), None)
    if match is None:
        print(json.dumps({"error": "No Argos model found for en -> %s" % target}), file=sys.stderr)
        sys.exit(3)
    argostranslate.package.install_from_path(match.download())

result = {key: argostranslate.translate.translate(str(value), "en", target) for key, value in entries.items()}
print(json.dumps(result, ensure_ascii=False))
`;
  const maskedEntries = {};
  const tokenMap = {};
  for (const [key, value] of Object.entries(entries)) {
    const { masked, tokens } = maskPlaceholders(value);
    maskedEntries[key] = masked;
    tokenMap[key] = tokens;
  }
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`Argos Translate failed for ${locale}: ${err || `exit code ${code}`}`));
      }
    });
    child.stdin.end(JSON.stringify({ target, entries: maskedEntries }));
  });
  const raw = JSON.parse(stdout);
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, restorePlaceholders(value, tokenMap[key] || [])])
  );
}

async function translateBatch(locale, entries) {
  if (Object.keys(entries).length === 0) return {};
  if (provider === "libretranslate" || provider === "libre") return translateWithLibreTranslate(locale, entries);
  if (provider === "argos") return translateWithArgos(locale, entries);
  throw new Error(`Unsupported I18N_PROVIDER "${provider}". Use libretranslate or argos.`);
}

function shouldTranslate({ key, englishValue, catalog, localeMeta }) {
  const sourceHash = hash(englishValue);
  const existing = catalog[key];
  const existingMeta = localeMeta[key];
  if (force) return true;
  if (existing == null) return true;
  if (existingMeta && existingMeta !== sourceHash) return true;

  if (!existingMeta && String(existing) === String(englishValue)) return true;
  return false;
}

function printProviderHelp() {
  if (provider === "libretranslate" || provider === "libre") {
    console.log("[i18n] using LibreTranslate. Start a local server first, for example:");
    console.log("[i18n]   docker run -it -p 5000:5000 libretranslate/libretranslate");
    console.log("[i18n] or set LIBRETRANSLATE_URL to another LibreTranslate endpoint.");
  } else if (provider === "argos") {
    console.log("[i18n] using Argos Translate. Install locally first:");
    console.log("[i18n]   python -m pip install argostranslate");
    console.log("[i18n] set ARGOS_PYTHON if python is not on PATH.");
  }
}

const english = await readJson(path.join(localeDir, "en.json"));
if (!english || typeof english !== "object") {
  throw new Error("Unable to read src/locales/en.json");
}

const meta = await readJson(metaPath, {});
printProviderHelp();

if (!dryRun && (provider === "libretranslate" || provider === "libre")) {
  await assertLibreTranslateReady();
}

let totalPending = 0;

for (const locale of locales) {
  const filePath = path.join(localeDir, `${locale}.json`);
  const catalog = await readJson(filePath, {});
  const localeMeta = meta[locale] || {};
  const pending = {};

  for (const [key, value] of Object.entries(english)) {
    if (shouldTranslate({ key, englishValue: value, catalog, localeMeta })) {
      pending[key] = value;
    } else {
      localeMeta[key] = hash(value);
    }
  }

  totalPending += Object.keys(pending).length;
  if (Object.keys(pending).length > 0) {
    if (dryRun) {
      console.log(`[i18n] ${locale}: ${Object.keys(pending).length} strings pending`);
      continue;
    }
    console.log(`[i18n] ${locale}: translating ${Object.keys(pending).length} strings with ${provider}`);
    const translated = await translateBatch(locale, pending);
    for (const [key, value] of Object.entries(pending)) {
      catalog[key] = String(translated[key] ?? value);
      localeMeta[key] = hash(english[key]);
    }
  } else {
    console.log(`[i18n] ${locale}: up to date`);
  }

  for (const key of Object.keys(catalog)) {
    if (!Object.prototype.hasOwnProperty.call(english, key)) {
      delete catalog[key];
      delete localeMeta[key];
    }
  }

  const ordered = Object.fromEntries(Object.keys(english).map((key) => [key, catalog[key] ?? english[key]]));
  meta[locale] = localeMeta;

  if (!dryRun) {
    await fs.writeFile(filePath, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  }
}

if (!dryRun) {
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

if (dryRun) {
  console.log(`[i18n] dry run complete. ${totalPending} total strings pending.`);
  if (failOnPending && totalPending > 0) {
    console.error("[i18n] locale catalogs are not up to date. Run scripts/i18n/sync-locales.ps1.");
    process.exit(1);
  }
} else {
  console.log("[i18n] translation files updated locally.");
}
