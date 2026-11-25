const repo = "https://github.com/prgmitchell/MIDIMaster";
const releases = new Map();

export function versionNumber(tag) {
  return String(tag || "").trim().replace(/^v/i, "");
}

export function releaseUrl(version, previous) {
  return previous ? `${repo}/compare/v${previous}...v${version}` : `${repo}/releases/tag/v${version}`;
}

export function loadRelease(version) {
  if (!releases.has(version)) {
    const endpoint = "https://api.github.com/repos/prgmitchell/MIDIMaster/releases/tags/";
    const request = fetch(endpoint + encodeURIComponent("v" + version), {
      signal: AbortSignal.timeout(7000),
      credentials: "omit",
    }).then(async (response) => {
      if (!response.ok) throw new Error("Release notes unavailable");
      const release = await response.json();
      if (versionNumber(release.tag_name) !== version) throw new Error("Unexpected release tag");
      return release;
    }).catch((error) => {
      releases.delete(version);
      throw error;
    });
    releases.set(version, request);
  }
  return releases.get(version);
}

function appendInline(element, text) {
  // Release prose is remote Markdown. Create text nodes for all of its content.
  const plain = text.replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g, "$1")
    .replace(/https:\/\/github\.com\/prgmitchell\/MIDIMaster\/pull\/(\d+)/gi, "#$1");
  const tokens = plain.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const token of tokens) {
    if (token.startsWith("**") && token.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      element.append(strong);
    } else if (token.startsWith("`") && token.endsWith("`") && token.length > 1) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      element.append(code);
    } else {
      element.append(token);
    }
  }
}

export function renderReleaseNotes(container, body, version) {
  const fragment = document.createDocumentFragment();
  let previousVersion = null;
  let block = null;
  for (const line of String(body || "").split(/\r?\n/).map((line) => line.trim())) {
    if (!line) {
      block = null;
      continue;
    }
    const comparison = line.match(/https:\/\/github\.com\/prgmitchell\/MIDIMaster\/compare\/v([\w.+-]+?)\.\.\.v([\w.+-]+)/i);
    if (comparison && comparison[2] === version && /full changelog/i.test(line)) {
      previousVersion = comparison[1];
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) {
      const title = document.createElement("h3");
      appendInline(title, heading[1]);
      fragment.append(title);
      block = null;
      continue;
    }
    const item = line.match(/^([-*+]|\d+\.)\s+(.+)/);
    const tag = item ? (/^\d/.test(item[1]) ? "ol" : "ul") : "p";
    if (block?.localName !== tag) {
      block = document.createElement(tag);
      fragment.append(block);
    }
    if (item) {
      const li = document.createElement("li");
      appendInline(li, item[2]);
      block.append(li);
    } else {
      if (block.childNodes.length) block.append(" ");
      appendInline(block, line);
    }
  }
  container.replaceChildren(fragment);
  if (!container.childNodes.length) container.textContent = "No release notes were published for this version.";
  return previousVersion;
}
