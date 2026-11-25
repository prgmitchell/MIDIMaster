import { loadRelease, releaseUrl, renderReleaseNotes, versionNumber } from "./release_notes.js";

export function createReleaseCard({ invoke, onClose, onSkip, onInstall }) {
  const card = document.createElement("article");
  card.className = "release-card";
  card.innerHTML = `
    <div class="release-header">
      <div class="release-brand">
        <img src="assets/MIDIMaster.png" alt="" width="26" height="26" draggable="false">
        MIDIMaster
      </div>
      <button class="release-close" type="button" aria-label="Close" title="Close">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>
      </button>
      <h1 id="release-title" tabindex="-1">What’s new in <span></span></h1>
      <div class="release-meta"></div>
    </div>
    <section class="release-notes" tabindex="0" aria-label="Release notes"></section>
    <p class="release-status" role="status" hidden></p>
    <div class="release-footer">
      <a class="release-link"><span>View release on GitHub</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M6 5h9v9"/></svg>
      </a>
      <div class="release-actions">
        <button class="release-skip" type="button">Skip update</button>
        <button class="release-install" type="button">Download and install</button>
      </div>
    </div>`;
  const notes = card.querySelector(".release-notes");
  const meta = card.querySelector(".release-meta");
  const link = card.querySelector(".release-link");
  const status = card.querySelector(".release-status");
  const skip = card.querySelector(".release-skip");
  const install = card.querySelector(".release-install");
  let latest = "";
  let current = "";
  let previous = null;
  let published = "";
  let notesLoaded = false;

  function updateMeta() {
    meta.replaceChildren();
    for (const value of [current && `Installed ${current}`, published]) {
      if (!value) continue;
      const part = document.createElement("span");
      part.textContent = value;
      meta.append(part);
    }
  }

  function updateLink() {
    link.href = releaseUrl(latest, previous);
    link.querySelector("span").textContent = previous ? "Full changelog" : "View release on GitHub";
  }

  function setStatus(message, { error = false } = {}) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("error", error);
  }

  function setBusy(busy) {
    skip.disabled = install.disabled = busy;
  }

  async function setRelease(latestVersion, currentVersion) {
    const version = versionNumber(latestVersion);
    current = versionNumber(currentVersion);
    updateMeta();
    if (!version || (version === latest && (notesLoaded || notes.getAttribute("aria-busy") === "true"))) return;
    if (latest !== version) {
      setStatus("");
      setBusy(false);
    }
    latest = version;
    notesLoaded = false;
    previous = null;
    published = "";
    card.querySelector("#release-title span").textContent = version;
    updateLink();
    updateMeta();
    notes.scrollTop = 0;
    notes.textContent = "Loading release notes…";
    notes.setAttribute("aria-busy", "true");
    try {
      const release = await loadRelease(version);
      if (latest !== version) return;
      previous = renderReleaseNotes(notes, release.body, version);
      notesLoaded = true;
      const date = new Date(release.published_at);
      if (release.published_at && Number.isFinite(date.getTime())) {
        published = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      }
      updateMeta();
      updateLink();
    } catch {
      if (latest === version) notes.textContent = "Release notes are unavailable right now.";
    } finally {
      if (latest === version) notes.setAttribute("aria-busy", "false");
    }
  }

  link.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await invoke("open_update_release_link", { version: latest, previousVersion: previous });
    } catch {
      setStatus("Couldn’t open the link in your browser.", { error: true });
    }
  });
  card.querySelector(".release-close").addEventListener("click", onClose);
  skip.addEventListener("click", onSkip);
  install.addEventListener("click", onInstall);
  return { card, setRelease, setBusy, setStatus };
}
