import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/appearance.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const appearance = await import(moduleUrl);

function testAppearanceDefaultsIncludePolishControls() {
  const defaults = appearance.defaultAppearanceSettings();

  assert.equal(defaults.backgroundEffects, true);
  assert.equal(defaults.effectIntensity, 30);
  assert.equal(defaults.surfaceContrast, 50);
  assert.equal(defaults.iconGlow, 50);
  assert.equal(defaults.fontSize, 12);
}

function testSystemPresetResolvesDarkFromOs() {
  const resolved = appearance.resolveAppearance(appearance.defaultAppearanceSettings(), {
    matchMediaSource: {
      matchMedia: () => ({ matches: true }),
    },
  });

  assert.equal(resolved.scheme, "dark");
  assert.equal(resolved.settings.activeThemeId, "system");
}

function testSystemPresetResolvesLightFromOs() {
  const resolved = appearance.resolveAppearance(appearance.defaultAppearanceSettings(), {
    matchMediaSource: {
      matchMedia: () => ({ matches: false }),
    },
  });

  assert.equal(resolved.scheme, "light");
}

function testEditingBuiltInKeepsSelectedPreset() {
  const next = appearance.applyAppearancePatch(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "ocean" },
    { accentColor: "#ff0000" },
    { t: (key) => key },
  );

  assert.equal(next.customThemes.length, 0);
  assert.equal(next.activeThemeId, "ocean");
  assert.equal(next.accentColor, "#ff0000");
}

function testBuiltInPresetSelectionResetsPresetAccent() {
  const edited = appearance.applyAppearancePatch(
    appearance.defaultAppearanceSettings(),
    { accentColor: "#ff0000", surfaceContrast: 88, iconGlow: 0, fontSize: 18 },
    { t: (key) => key },
  );
  const next = appearance.applyBuiltInPreset(edited, "forest");

  assert.equal(next.activeThemeId, "forest");
  assert.equal(next.accentColor, "#69c95a");
  assert.equal(next.surfaceContrast, 50);
  assert.equal(next.iconGlow, 50);
  assert.equal(next.fontSize, 12);
  assert.equal(next.customThemes.length, 0);
}

function testPresetTokenOverrideDoesNotCreateCustomTheme() {
  const next = appearance.applyAppearancePatch(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "midnight" },
    { tokens: { themeTint: "#123456" } },
    { t: (key) => key },
  );
  const resolved = appearance.resolveAppearance(next, {
    matchMediaSource: {
      matchMedia: () => ({ matches: true }),
    },
  });
  const backend = appearance.toBackendAppearanceSettings(next);

  assert.equal(next.customThemes.length, 0);
  assert.equal(next.activeThemeId, "midnight");
  assert.equal(resolved.tokens.themeTint, "#123456");
  assert.equal(backend.tokens["--theme-tint"], "#123456");
}

function testOldSurfaceTokenOverridesAreIgnored() {
  const next = appearance.applyAppearancePatch(
    appearance.defaultAppearanceSettings(),
    { tokens: { appBg: "#ffffff", topbarBg: "#ffffff", textPrimary: "#fefefe" } },
    { t: (key) => key },
  );
  const backend = appearance.toBackendAppearanceSettings(next);

  assert.equal(next.tokens.appBg, undefined);
  assert.equal(next.tokens.topbarBg, undefined);
  assert.equal(next.tokens.textPrimary, "#fefefe");
  assert.equal(backend.tokens["--app-bg"], undefined);
  assert.equal(backend.tokens["--text-primary"], "#fefefe");
}

function testIconColorGeneratesLogoFilter() {
  const next = appearance.applyAppearancePatch(
    appearance.defaultAppearanceSettings(),
    { tokens: { iconColor: "#ec4899", iconColorIntensity: 62 } },
    { t: (key) => key },
  );
  const darkResolved = appearance.resolveAppearance(next, {
    matchMediaSource: {
      matchMedia: () => ({ matches: true }),
    },
  });
  const lightResolved = appearance.resolveAppearance({ ...next, activeThemeId: "light" }, {
    matchMediaSource: {
      matchMedia: () => ({ matches: false }),
    },
  });
  const backend = appearance.toBackendAppearanceSettings(next);

  assert.equal(next.tokens.iconColor, "#ec4899");
  assert.equal(next.tokens.iconColorIntensity, "62");
  assert.notEqual(darkResolved.tokens.iconColor, "#ec4899");
  assert.match(darkResolved.tokens.logoFilter, /hue-rotate\(/);
  assert.doesNotMatch(darkResolved.tokens.logoFilter, /invert\(1\)/);
  assert.match(lightResolved.tokens.logoFilter, /hue-rotate\(/);
  assert.doesNotMatch(lightResolved.tokens.logoFilter, /invert\(1\)/);
  assert.match(lightResolved.tokens.logoFilter, /contrast\(98%\)/);
  assert.equal(backend.tokens["--icon-color"], "#ec4899");
  assert.equal(backend.tokens["--icon-color-intensity"], "62");
}

function testDefaultLogoIsUntinted() {
  const darkResolved = appearance.resolveAppearance(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "dark" },
    {
      matchMediaSource: {
        matchMedia: () => ({ matches: true }),
      },
    },
  );

  const lightResolved = appearance.resolveAppearance(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "light" },
    {
      matchMediaSource: {
        matchMedia: () => ({ matches: false }),
      },
    },
  );

  assert.equal(darkResolved.tokens.logoFilter, "hue-rotate(0deg) saturate(100%) brightness(100%)");
  assert.notEqual(darkResolved.tokens.logoGlow, "rgba(0, 0, 0, 0)");
  assert.equal(lightResolved.tokens.logoFilter, "hue-rotate(0deg) saturate(100%) brightness(100%)");
  assert.notEqual(lightResolved.tokens.logoGlow, "rgba(0, 0, 0, 0)");
}

function testStyledPresetLogoIsTinted() {
  const resolved = appearance.resolveAppearance(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "midnight" },
    {
      matchMediaSource: {
        matchMedia: () => ({ matches: true }),
      },
    },
  );

  assert.notEqual(resolved.tokens.logoFilter, "hue-rotate(0deg) saturate(100%) brightness(100%)");
  assert.notEqual(resolved.tokens.logoGlow, "rgba(0, 0, 0, 0)");
}

function testAccentDoesNotDriveStyledPresetLogo() {
  const base = appearance.resolveAppearance(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "midnight" },
    {
      matchMediaSource: {
        matchMedia: () => ({ matches: true }),
      },
    },
  );
  const edited = appearance.applyAppearancePatch(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "midnight" },
    { accentColor: "#ff0000" },
    { t: (key) => key },
  );
  const resolved = appearance.resolveAppearance(edited, {
    matchMediaSource: {
      matchMedia: () => ({ matches: true }),
    },
  });

  assert.equal(resolved.tokens.iconColor, base.tokens.iconColor);
  assert.equal(resolved.tokens.logoFilter, base.tokens.logoFilter);
}

function testColorIntensitiesAreNormalized() {
  const next = appearance.applyAppearancePatch(
    appearance.defaultAppearanceSettings(),
    {
      tokens: {
        accentIntensity: 40,
        themeTintIntensity: "75",
        controlBorderIntensity: 125,
        textPrimaryIntensity: -10,
      },
    },
    { t: (key) => key },
  );
  const backend = appearance.toBackendAppearanceSettings(next);

  assert.equal(next.tokens.accentIntensity, "40");
  assert.equal(next.tokens.themeTintIntensity, "75");
  assert.equal(next.tokens.controlBorderIntensity, "100");
  assert.equal(next.tokens.textPrimaryIntensity, "0");
  assert.equal(backend.tokens["--accent-intensity"], "40");
  assert.equal(backend.tokens["--theme-tint-intensity"], "75");
}

function testIconGlowIsClampedAndSerialized() {
  const low = appearance.normalizeAppearanceSettings({ iconGlow: -20 });
  const high = appearance.normalizeAppearanceSettings({ iconGlow: 140 });

  assert.equal(low.iconGlow, 0);
  assert.equal(high.iconGlow, 100);
  assert.equal(appearance.toBackendAppearanceSettings(high).icon_glow, 100);
}

function testDefaultLogoGlowChangesWithoutTinting() {
  const darkOff = appearance.resolveAppearance(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "dark", iconGlow: 0 },
    {
      matchMediaSource: {
        matchMedia: () => ({ matches: true }),
      },
    },
  );
  const darkHigh = appearance.resolveAppearance(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "dark", iconGlow: 100 },
    {
      matchMediaSource: {
        matchMedia: () => ({ matches: true }),
      },
    },
  );
  const lightOff = appearance.resolveAppearance(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "light", iconGlow: 0 },
    {
      matchMediaSource: {
        matchMedia: () => ({ matches: false }),
      },
    },
  );
  const lightHigh = appearance.resolveAppearance(
    { ...appearance.defaultAppearanceSettings(), activeThemeId: "light", iconGlow: 100 },
    {
      matchMediaSource: {
        matchMedia: () => ({ matches: false }),
      },
    },
  );

  assert.equal(darkOff.tokens.logoFilter, "hue-rotate(0deg) saturate(100%) brightness(100%)");
  assert.equal(darkHigh.tokens.logoFilter, "hue-rotate(0deg) saturate(100%) brightness(100%)");
  assert.match(darkOff.tokens.logoGlow, /, 0\)$/);
  assert.notEqual(darkHigh.tokens.logoGlow, darkOff.tokens.logoGlow);
  assert.equal(lightOff.tokens.logoFilter, "hue-rotate(0deg) saturate(100%) brightness(100%)");
  assert.equal(lightHigh.tokens.logoFilter, "hue-rotate(0deg) saturate(100%) brightness(100%)");
  assert.match(lightOff.tokens.logoGlow, /, 0\)$/);
  assert.notEqual(lightHigh.tokens.logoGlow, lightOff.tokens.logoGlow);
}

function testBackgroundGlowPatchDisablesAtZero() {
  const next = appearance.applyAppearancePatch(
    appearance.defaultAppearanceSettings(),
    appearance.appearanceBackgroundGlowPatch(0),
    { t: (key) => key },
  );

  assert.equal(next.backgroundEffects, false);
  assert.equal(next.effectIntensity, 0);
  assert.equal(appearance.appearanceBackgroundGlowValue(next), 0);
}

function testBackgroundGlowPatchEnablesAboveZero() {
  const next = appearance.applyAppearancePatch(
    { ...appearance.defaultAppearanceSettings(), backgroundEffects: false, effectIntensity: 0 },
    appearance.appearanceBackgroundGlowPatch(64),
    { t: (key) => key },
  );

  assert.equal(next.backgroundEffects, true);
  assert.equal(next.effectIntensity, 64);
  assert.equal(appearance.appearanceBackgroundGlowValue(next), 64);
}

function testSurfaceContrastIsClampedAndChangesSurfaceTokens() {
  const low = appearance.normalizeAppearanceSettings({ surfaceContrast: -20 });
  const high = appearance.normalizeAppearanceSettings({ surfaceContrast: 140 });
  const neutralResolved = appearance.resolveAppearance(appearance.defaultAppearanceSettings(), {
    matchMediaSource: {
      matchMedia: () => ({ matches: true }),
    },
  });
  const highResolved = appearance.resolveAppearance(high, {
    matchMediaSource: {
      matchMedia: () => ({ matches: true }),
    },
  });

  assert.equal(low.surfaceContrast, 0);
  assert.equal(high.surfaceContrast, 100);
  assert.equal(appearance.toBackendAppearanceSettings(high).surface_contrast, 100);
  assert.notEqual(highResolved.tokens.surface, neutralResolved.tokens.surface);
  assert.notEqual(highResolved.tokens.controlBorder, neutralResolved.tokens.controlBorder);
}

function testInvalidColorFallsBack() {
  const normalized = appearance.normalizeAppearanceSettings({
    activeThemeId: "dark",
    accentColor: "url(javascript:alert(1))",
  });

  assert.equal(normalized.accentColor, "#5aa7ff");
}

function testDuplicateCustomNamesGetNumbered() {
  const current = appearance.normalizeAppearanceSettings({
    customThemes: [
      { id: "custom-theme", name: "Custom Theme" },
    ],
  });
  const nextTheme = appearance.makeCustomThemeFromAppearance(current, {
    name: "Custom Theme",
    matchMediaSource: {
      matchMedia: () => ({ matches: true }),
    },
  });

  assert.equal(nextTheme.name, "Custom Theme 2");
  assert.equal(nextTheme.id, "custom-theme-2");
}

testAppearanceDefaultsIncludePolishControls();
testSystemPresetResolvesDarkFromOs();
testSystemPresetResolvesLightFromOs();
testEditingBuiltInKeepsSelectedPreset();
testBuiltInPresetSelectionResetsPresetAccent();
testPresetTokenOverrideDoesNotCreateCustomTheme();
testOldSurfaceTokenOverridesAreIgnored();
testIconColorGeneratesLogoFilter();
testDefaultLogoIsUntinted();
testStyledPresetLogoIsTinted();
testAccentDoesNotDriveStyledPresetLogo();
testColorIntensitiesAreNormalized();
testIconGlowIsClampedAndSerialized();
testDefaultLogoGlowChangesWithoutTinting();
testBackgroundGlowPatchDisablesAtZero();
testBackgroundGlowPatchEnablesAboveZero();
testSurfaceContrastIsClampedAndChangesSurfaceTokens();
testInvalidColorFallsBack();
testDuplicateCustomNamesGetNumbered();

console.log("Appearance tests passed");
