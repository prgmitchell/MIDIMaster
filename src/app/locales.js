export const supportedLocales = [
  { code: "en", label: "English", libreTarget: "en" },
  { code: "fr", label: "Français", libreTarget: "fr" },
  { code: "es", label: "Español", libreTarget: "es" },
  { code: "de", label: "Deutsch", libreTarget: "de" },
  { code: "it", label: "Italiano", libreTarget: "it" },
  { code: "pt-BR", label: "Português (Brasil)", libreTarget: "pt-BR" },
  { code: "nl", label: "Nederlands", libreTarget: "nl" },
  { code: "pl", label: "Polski", libreTarget: "pl" },
  { code: "ja", label: "日本語", libreTarget: "ja" },
  { code: "ko", label: "한국어", libreTarget: "ko" },
  { code: "zh-Hans", label: "简体中文", libreTarget: "zh-Hans" },
];

export const sourceLocale = "en";

export const targetLocales = supportedLocales.filter((locale) => locale.code !== sourceLocale);

export function normalizeLocale(locale) {
  const value = String(locale || "").trim();
  return supportedLocales.some((candidate) => candidate.code === value) ? value : sourceLocale;
}

export function localeCodes() {
  return supportedLocales.map((locale) => locale.code);
}
