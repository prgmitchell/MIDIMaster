import { bindingsTemplate } from "../features/bindings/template.js";
import { settingsTemplate } from "../features/settings/template.js";
import { targetsTemplate } from "../features/targets/template.js";
export const FEATURE_TEMPLATES = Object.freeze({
  bindings: bindingsTemplate,
  settings: settingsTemplate,
  targets: targetsTemplate,
});
/** Mount before DOM references or feature controllers are constructed. Idempotent. */
export function mountFeatureTemplates(root = document) {
  for (const placeholder of root.querySelectorAll("template[data-feature-template]")) {
    const html = FEATURE_TEMPLATES[placeholder.dataset.featureTemplate];
    if (html === undefined) throw new Error("Unknown feature template");
    placeholder.outerHTML = html;
  }
}
