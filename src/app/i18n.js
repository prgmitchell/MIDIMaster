import { normalizeLocale, supportedLocales } from "./locales.js";

export { supportedLocales };

const supportedLocaleCodes = new Set(supportedLocales.map((locale) => locale.code));
let currentLocale = "en";
let englishCatalog = {};
let activeCatalog = {};
let catalogsLoaded = false;
let warnedCatalogFallback = false;

async function loadCatalog(locale) {
  const normalized = normalizeLocale(locale);
  const response = await fetch(`./locales/${encodeURIComponent(normalized)}.json`, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Unable to load locale ${normalized}: ${response.status}`);
  }
  return response.json();
}

function interpolate(template, params = {}) {
  return String(template ?? "").replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    return String(params[name] ?? "");
  });
}

export function getLocale() {
  return currentLocale;
}

export function isSupportedLocale(locale) {
  return supportedLocaleCodes.has(String(locale || "").trim());
}

export async function initI18n(locale = "en") {
  if (!catalogsLoaded) {
    englishCatalog = await loadCatalog("en");
    catalogsLoaded = true;
  }
  await setLocale(locale);
}

export async function setLocale(locale = "en") {
  const normalized = normalizeLocale(locale);
  currentLocale = normalized;
  if (!catalogsLoaded) {
    englishCatalog = await loadCatalog("en");
    catalogsLoaded = true;
  }
  activeCatalog = normalized === "en"
    ? englishCatalog
    : await loadCatalog(normalized).catch((error) => {
      if (!warnedCatalogFallback) {
        warnedCatalogFallback = true;
        console.warn(`[i18n] Falling back to English catalog for ${normalized}`, error);
      }
      return englishCatalog;
    });
  document.documentElement.lang = normalized;
  applyTranslations();
  window.dispatchEvent(new CustomEvent("midimaster:locale-changed", { detail: { locale: normalized } }));
  return normalized;
}

export function t(key, params = {}) {
  const id = String(key || "");
  const value = activeCatalog[id] ?? englishCatalog[id] ?? id;
  return interpolate(value, params);
}

function applyText(el, key) {
  if (!key) return;
  el.textContent = t(key);
}

export function applyTranslations(root = document) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll("[data-i18n]").forEach((el) => applyText(el, el.dataset.i18n));
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const value = t(el.dataset.i18nTitle);
    el.setAttribute("title", value);
    el.title = value;
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  });
}
