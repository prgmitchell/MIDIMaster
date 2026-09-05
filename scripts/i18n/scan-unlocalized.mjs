import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readAppHtml } from "../lib/app_html.mjs";

const root = process.cwd();
const scanRoots = [path.join(root, "src", "app"), path.join(root, "src", "features")];
const htmlFiles = [path.join(root, "src", "index.html")];
const jsFiles = [];

const ignoredLiteralPatterns = [
  /^[\s\d%/.,:;()[\]{}|_-]+$/,
  /^#[0-9a-f]+$/i,
  /^data:/i,
  /^<svg\b/i,
  /^\.?[A-Za-z0-9_-]+$/,
  /^[+-]?\d+(?:\.\d+)?\s*dB$/i,
  /^MIDI: \$\{/,
];

const ignoredLinePatterns = [
  /console\./,
  /throw new Error/,
  /diagnostic/,
  /className\s*=/,
  /classList\./,
  /dataset\./,
  /querySelector/,
  /getElementById/,
  /createElement/,
  /addEventListener/,
  /localStorage/,
  /setInterval/,
  /setTimeout/,
  /innerHTML\s*=\s*['"`]\s*<svg/,
  /categorySvg/,
];

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectFiles(filePath);
      } else if (entry.name.endsWith(".js")) {
        jsFiles.push(filePath);
      }
    }),
  );
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function shouldIgnoreLiteral(value) {
  const text = String(value || "").trim();
  const withoutTemplates = text.replace(/\$\{[^}]*\}/g, "");
  const withoutEscapes = withoutTemplates.replace(/\\u[0-9a-f]{4}/gi, "");
  return (
    !text || !/[A-Za-z]/.test(withoutEscapes) || ignoredLiteralPatterns.some((pattern) => pattern.test(text))
  );
}

function shouldIgnoreLine(line) {
  return (
    ignoredLinePatterns.some((pattern) => pattern.test(line)) ||
    /\bt\(\s*["']/.test(line) ||
    /data-i18n/.test(line)
  );
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function scanJs(filePath, source) {
  const findings = [];
  const assignmentPattern = /\b(textContent|title|placeholder|innerHTML)\s*=\s*(["'`])([\s\S]*?)\2/g;
  let match;
  while ((match = assignmentPattern.exec(source))) {
    const prop = match[1];
    const value = match[3];
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineEnd = source.indexOf("\n", match.index);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    if (prop === "innerHTML" && String(value).includes("<")) continue;
    if (shouldIgnoreLine(line) || shouldIgnoreLiteral(value)) continue;
    findings.push({
      file: relative(filePath),
      line: lineNumberForOffset(source, match.index),
      value: value.trim().slice(0, 120),
    });
  }

  const attributePattern =
    /setAttribute\(\s*(["'])(title|aria-label|placeholder)\1\s*,\s*(["'`])([\s\S]*?)\3/g;
  while ((match = attributePattern.exec(source))) {
    const value = match[4];
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineEnd = source.indexOf("\n", match.index);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    if (shouldIgnoreLine(line) || shouldIgnoreLiteral(value)) continue;
    findings.push({
      file: relative(filePath),
      line: lineNumberForOffset(source, match.index),
      value: value.trim().slice(0, 120),
    });
  }
  return findings;
}

function scanHtml(filePath, source) {
  const findings = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/[A-Za-z]/.test(line)) return;
    const visible = line.match(/>([^<>{}]*[A-Za-z][^<>{}]*)</);
    const visibleTagStart = visible ? line.lastIndexOf("<", visible.index) : -1;
    const visibleTag = visibleTagStart >= 0 ? line.slice(visibleTagStart, visible.index + 1) : "";
    const hasDataI18n = /data-i18n(?:\s|=|>)/.test(visibleTag);
    if (visible && !hasDataI18n && !shouldIgnoreLiteral(visible[1])) {
      findings.push({ file: relative(filePath), line: index + 1, value: visible[1].trim().slice(0, 120) });
    }
    const tagTail = lines.slice(index, Math.min(lines.length, index + 12)).join(" ");
    const currentTag = tagTail.split(">")[0] || line;
    for (const attr of ["placeholder", "title", "aria-label"]) {
      const attrMatch = line.match(new RegExp(`${attr}="([^"]*[A-Za-z][^"]*)"`));
      if (
        attrMatch &&
        !new RegExp(`data-i18n-${attr.replace("aria-label", "aria-label")}`).test(currentTag)
      ) {
        findings.push({ file: relative(filePath), line: index + 1, value: `${attr}="${attrMatch[1]}"` });
      }
    }
  });
  return findings;
}

await Promise.all(scanRoots.map(collectFiles));

const findings = [];
for (const filePath of jsFiles) {
  // Feature templates remain HTML and must use HTML's data-i18n attribute rules.
  if (!filePath.endsWith(`${path.sep}template.js`))
    findings.push(...scanJs(filePath, await fs.readFile(filePath, "utf8")));
}
for (const filePath of htmlFiles) {
  findings.push(...scanHtml(filePath, await readAppHtml()));
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`[i18n] unlocalized string candidate ${finding.file}:${finding.line}: ${finding.value}`);
  }
  process.exit(1);
}

console.log(`[i18n] scanned ${jsFiles.length + htmlFiles.length} frontend files for unlocalized strings.`);
