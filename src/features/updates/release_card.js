import { applyTranslations, getLocale, t } from "../../app/i18n.js";
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
      <button class="release-close" type="button" data-i18n-aria-label="common.close" data-i18n-title="common.close">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>
      </button>
      <h1 id="release-title" tabindex="-1"></h1>
      <div class="release-meta"></div>
    </div>
    <section class="release-notes" tabindex="0" data-i18n-aria-label="release.notes"></section>
    <p class="release-status" role="status" hidden></p>
    <div class="release-footer">
      <a class="release-link"><span></span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M6 5h9v9"/></svg>
      </a>
      <div class="release-actions">
        <button class="release-skip" type="button" data-i18n="release.skip"></button>
        <button class="release-install" type="button" data-i18n="settings.downloadAndInstall"></button>
      </div>
    </div>`;
  applyTranslations(card);
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
    for (const value of [current && t("release.installed", { version: current }), published]) {
      if (!value) continue;
      const part = document.createElement("span");
      part.textContent = value;
      meta.append(part);
    }
  }

  function updateLink() {
    link.href = releaseUrl(latest, previous);
    link.querySelector("span").textContent = previous ? t("release.changelog") : t("release.viewOnGitHub");
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
    card.querySelector("#release-title").textContent = t("release.title", { version });
    updateLink();
    updateMeta();
    notes.scrollTop = 0;
    notes.textContent = t("release.loading");
    notes.setAttribute("aria-busy", "true");
    try {
      const release = await loadRelease(version);
      if (latest !== version) return;
      previous = renderReleaseNotes(notes, release.body, version);
      notesLoaded = true;
      const date = new Date(release.published_at);
      if (release.published_at && Number.isFinite(date.getTime())) {
        published = date.toLocaleDateString(getLocale(), { year: "numeric", month: "short", day: "numeric" });
      }
      updateMeta();
      updateLink();
    } catch {
      if (latest === version) notes.textContent = t("release.unavailable");
    } finally {
      if (latest === version) notes.setAttribute("aria-busy", "false");
    }
  }

  link.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await invoke("open_update_release_link", { version: latest, previousVersion: previous });
    } catch {
      setStatus(t("release.linkFailed"), { error: true });
    }
  });
  card.querySelector(".release-close").addEventListener("click", onClose);
  skip.addEventListener("click", onSkip);
  install.addEventListener("click", onInstall);
  return { card, setRelease, setBusy, setStatus };
}
