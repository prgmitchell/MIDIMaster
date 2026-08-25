import { readFile } from "node:fs/promises";

const LOCAL_IMPORT_PATTERN = /@import\s+url\((?:"([^"]+)"|'([^']+)'|([^\s)]+))\)\s*;/g;

export async function readCssBundle(url, importStack = new Set()) {
  const resolvedUrl = url instanceof URL ? url : new URL(url, import.meta.url);
  if (importStack.has(resolvedUrl.href)) {
    throw new Error(`Circular CSS import: ${resolvedUrl.href}`);
  }

  const source = await readFile(resolvedUrl, "utf8");
  const nextStack = new Set(importStack).add(resolvedUrl.href);
  let bundle = "";
  let cursor = 0;

  for (const match of source.matchAll(LOCAL_IMPORT_PATTERN)) {
    bundle += source.slice(cursor, match.index);
    const importPath = match[1] ?? match[2] ?? match[3];
    bundle += await readCssBundle(new URL(importPath, resolvedUrl), nextStack);
    cursor = match.index + match[0].length;
  }

  return bundle + source.slice(cursor);
}
