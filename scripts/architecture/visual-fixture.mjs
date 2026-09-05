/** Render deterministic fixtures through the actual feature controllers, with no native calls. */
export async function renderFixture({
  variant,
  theme = "dark",
  compact = false,
  view = "list",
  anchor = "top-right",
  style = "midnight",
}) {
  const base = `/${variant}/src`;
  const load = (path) => import(`${base}/${path}`);
  // Initial renders are synchronous; prevent preview polling from rebuilding text during capture.
  window.setInterval = () => 0;
  const stable = document.createElement("style");
  stable.textContent =
    "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";
  document.head.append(stable);
  if (view === "osd") {
    document.body.dataset.anchor = anchor;
    document.body.dataset.osdStyle = style;
    const { createOsdFeature } = await load("features/osd/osd.js");
    const osd = createOsdFeature({
      osdElement: document.querySelector("#volume-osd"),
      isOsdWindow: true,
      osdDebugAlways: true,
      getOsdSettings: () => ({ enabled: true, showBindingName: true }),
      resolveOsdTarget: () => ({ label: "Music" }),
      resolveTargetKey: () => "master",
    });
    osd.handleOsdUpdate({
      target: "Master",
      volume: 0.42,
      input_value: 0.5,
      osd_enabled: true,
      binding_id: "music",
      binding_name: "Music",
      binding_primary_target: "Master",
    });
  } else {
    if (variant === "after") (await load("app/feature_templates.js")).mountFeatureTemplates();
    const { createDomRefs } = await load("app/dom_refs.js");
    const { defaultAppearanceSettings, applyBuiltInPreset, applyAppearanceToDocument } =
      await load("app/appearance.js");
    applyAppearanceToDocument(applyBuiltInPreset(defaultAppearanceSettings(), theme));
    const dom = createDomRefs();
    const { normalizeBinding } = await load("core/binding_model.js");
    const { createBindingsFeature } = await load("features/bindings/bindings.js");
    let bindings = [
      {
        id: "fader",
        name: "Music",
        control_kind: "Continuous",
        action: "Volume",
        targets: ["Master"],
        control: { channel: 1, controller: 7, msg_type: "ControlChange" },
      },
      { id: "button", name: "Mute", control_kind: "Button", action: "ToggleMute", targets: ["Master"] },
      {
        id: "macro",
        name: "Scene change",
        control_kind: "Button",
        action: "Macro",
        targets: ["Macro"],
        macro_steps: [
          { kind: "wait", delay_ms: 100 },
          { kind: "parallel", steps: [] },
        ],
      },
      {
        id: "sound",
        name: "Applause",
        control_kind: "Button",
        action: "Soundboard",
        targets: ["Soundboard"],
      },
    ].map(normalizeBinding);
    const invoke = async (command) =>
      command === "get_virtual_audio_status" ? { install_state: "not-installed" } : [];
    const feature = createBindingsFeature({
      invoke,
      dom: dom.bindings,
      getBindings: () => bindings,
      setBindings: (next) => {
        bindings = next;
      },
      getVolumeForTarget: () => 0.42,
      bindingLastValues: {},
      bindingMuteValues: {},
      bindingInteractionTimes: {},
      i18n: { t: (key) => key },
    });
    feature.bindUi();
    await feature.setCompactBindings(compact);
    feature.renderBindings();
    if (view === "fader" || view === "button") feature.beginBindingEdit(view);
    if (view === "macro")
      feature.getRenderedBindingRefs("macro").item.querySelector(".binding-macro-edit-button").click();
    if (view === "sound")
      feature.getRenderedBindingRefs("sound").item.querySelector(".binding-soundboard-edit-button").click();
    if (view === "settings") {
      const { createSettingsFeature } = await load("features/settings/settings.js");
      const { createSettingsStore } = await load("app/settings_store.js");
      const settings = createSettingsFeature({
        invoke,
        listen: async () => () => {},
        dom: dom.settings,
        settingsStore: createSettingsStore({ invoke }),
        i18n: { t: (key) => key },
      });
      settings.bindUi();
      settings.activateSettingsSection("appearance");
      dom.settings.settingsPanel.classList.remove("hidden");
      dom.settings.settingsPanel.classList.add("active");
      dom.shell.mainScreen.classList.remove("active");
    }
    if (view === "targets") {
      const { createTargetsFeature } = await load("features/targets/targets.js");
      const { createTargetCore } = await load("core/target_core.js");
      const core = createTargetCore({
        getSessions: () => [],
        getPlaybackDevices: () => [],
        getRecordingDevices: () => [],
      });
      const targets = createTargetsFeature({
        invoke,
        dom: dom.targets,
        i18n: { t: (key) => key },
        normalizeSessionKey: core.normalizeSessionKey,
        integrationTargetKey: core.integrationTargetKey,
        resolveOsdTarget: core.resolveOsdTarget,
      });
      targets.bindUi();
      const picker = targets.buildTargetSelect(["Master"], true, "ToggleMute");
      document.body.append(picker);
      await picker.openTargetPicker();
    }
  }
  await document.fonts.ready;
  await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
  document.activeElement?.blur();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (document.querySelector(".error-binding")) throw new Error("Binding fixture failed to render");
  return [...document.querySelectorAll("#binding-config-panel *")].map((element) => {
    const rect = element.getBoundingClientRect(),
      css = getComputedStyle(element);
    return {
      id: element.id,
      text: element.textContent,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      font: css.font,
      color: css.color,
      styles: Object.fromEntries([...css].map((key) => [key, css.getPropertyValue(key)])),
    };
  });
}
