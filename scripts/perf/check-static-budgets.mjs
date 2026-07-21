#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli.mjs";
import { listFilesRecursively, pathExists, readJson } from "./lib/files.mjs";

function localReference(value) {
  if (!value || /^(?:data:|blob:|https?:|tauri:|#)/i.test(value)) return null;
  return value.split(/[?#]/, 1)[0];
}

function htmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
    attributes[match[1].toLowerCase()] = match[2];
  }
  return attributes;
}

export async function checkStaticBudgets({ root, config }) {
  const failures = [];
  const entryModules = new Map();
  for (const entry of config.entries) {
    const htmlPath = resolve(root, entry.html);
    if (!await pathExists(htmlPath)) {
      failures.push(`${entry.name}: missing HTML entry ${entry.html}`);
      continue;
    }
    const html = await readFile(htmlPath, "utf8");
    const modules = [...html.matchAll(/<script\b[^>]*>/gi)]
      .map((match) => htmlAttributes(match[0]))
      .filter((attributes) => attributes.type?.toLowerCase() === "module" && attributes.src)
      .map((attributes) => basename(localReference(attributes.src) ?? ""));
    entryModules.set(entry.name, new Set(modules));
    if (modules.length !== 1) failures.push(`${entry.name}: expected exactly one module entry, found ${modules.length}`);
    for (const module of modules) {
      if (!entry.allowed_modules.includes(module)) failures.push(`${entry.name}: unexpected module ${module}`);
      if (entry.forbidden_modules.includes(module)) failures.push(`${entry.name}: forbidden shared startup module ${module}`);
    }
  }

  const moduleOwners = new Map();
  for (const [entry, modules] of entryModules) {
    for (const module of modules) moduleOwners.set(module, [...(moduleOwners.get(module) ?? []), entry]);
  }
  for (const [module, owners] of moduleOwners) {
    if (owners.length > 1) failures.push(`module ${module} is loaded by multiple window entries: ${owners.join(", ")}`);
  }

  const initialHtmlPath = resolve(root, config.initial_images.html);
  if (await pathExists(initialHtmlPath)) {
    const html = await readFile(initialHtmlPath, "utf8");
    const eagerImages = [...html.matchAll(/<img\b[^>]*>/gi)]
      .map((match) => htmlAttributes(match[0]))
      .filter((attributes) => attributes.loading?.toLowerCase() !== "lazy"
        && [attributes.src, attributes["data-dark-src"], attributes["data-light-src"]].some(localReference));
    let totalBytes = 0;
    let themeLogoCount = 0;
    for (const image of eagerImages) {
      const references = [...new Set([image.src, image["data-dark-src"], image["data-light-src"]].map(localReference).filter(Boolean))];
      let largestVariant = 0;
      for (const reference of references) {
        const imagePath = resolve(dirname(initialHtmlPath), reference);
        if (!await pathExists(imagePath)) {
          failures.push(`main: eager image does not exist: ${relative(root, imagePath)}`);
          continue;
        }
        const bytes = (await stat(imagePath)).size;
        largestVariant = Math.max(largestVariant, bytes);
        if (bytes > config.initial_images.maximum_single_bytes) {
          failures.push(`main: eager image ${relative(root, imagePath)} is ${bytes} bytes (limit ${config.initial_images.maximum_single_bytes})`);
        }
      }
      // Theme variants are mutually exclusive, so budget their worst case.
      totalBytes += largestVariant;
      if ((image.class ?? "").split(/\s+/).some((name) => name.startsWith("app-logo"))) themeLogoCount += 1;
    }
    if (totalBytes > config.initial_images.maximum_total_bytes) {
      failures.push(`main: eager image payload is ${totalBytes} bytes (limit ${config.initial_images.maximum_total_bytes})`);
    }
    if (themeLogoCount > config.initial_images.maximum_eager_theme_logos) {
      failures.push(`main: ${themeLogoCount} theme logos load eagerly (limit ${config.initial_images.maximum_eager_theme_logos})`);
    }
  }

  const frontendFiles = await listFilesRecursively(resolve(root, "src"));
  for (const path of frontendFiles) {
    const bytes = (await stat(path)).size;
    if (bytes > config.maximum_frontend_file_bytes) {
      failures.push(`${relative(root, path)} is ${bytes} bytes (frontend file limit ${config.maximum_frontend_file_bytes})`);
    }
  }
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["help"] });
  if (args.help) {
    console.log("Usage: node scripts/perf/check-static-budgets.mjs [--root .] [--config scripts/perf/config/asset-budgets.json]");
    return;
  }
  const root = resolve(args.root ?? ".");
  const config = await readJson(resolve(root, args.config ?? "scripts/perf/config/asset-budgets.json"));
  const failures = await checkStaticBudgets({ root, config });
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("Static performance budgets passed.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
