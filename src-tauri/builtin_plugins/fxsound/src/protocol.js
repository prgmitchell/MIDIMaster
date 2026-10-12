export const ID = "fxsound";
export const WRITE_INTERVAL_MS = 100;
export const GROUPS = ["low", "mid", "high"];
export const EFFECTS = {
  clarity: "Clarity",
  ambience: "Ambience",
  surround: "Surround",
  dynamicboost: "Dynamic Boost",
  bass: "Bass Boost",
};
export const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
export const gainFromValue = (value) =>
  Math.round((clamp01(value) * 24 - 12) * 100) / 100;
export const valueFromGain = (gain) => clamp01((gain + 12) / 24);
export const innerTarget = (raw) => raw?.Integration || raw?.integration || raw;
export const targetKey = (raw) => {
  const target = innerTarget(raw);
  return `${target?.kind}:${target?.data?.group ?? target?.data?.index ?? target?.data?.key ?? ""}`;
};

export function bandsForGroup(status, group) {
  return (status?.equalizer?.bands || []).filter((band) => {
    if (group === "low") return band.frequency < 250;
    if (group === "mid") return band.frequency >= 250 && band.frequency < 4000;
    if (group === "high") return band.frequency >= 4000;
    return false;
  });
}

export function targetValue(raw, status) {
  const target = innerTarget(raw);
  if (!status || !target) return null;
  const data = target.data || {};
  if (target.kind === "group") {
    const bands = bandsForGroup(status, data.group);
    return bands.length
      ? valueFromGain(bands.reduce((sum, b) => sum + b.gain, 0) / bands.length)
      : null;
  }
  if (target.kind === "band") {
    const band = status.equalizer.bands.find((b) => b.index === data.index);
    return band ? valueFromGain(band.gain) : null;
  }
  if (target.kind === "effect")
    return Number.isFinite(status.effects[data.key])
      ? clamp01(status.effects[data.key] / 10)
      : null;
  if (target.kind === "master_gain")
    return clamp01((status.equalizer.master_gain + 20) / 40);
  if (target.kind === "power") return status.power ? 1 : 0;
  return null;
}

export function writesForTarget(raw, value, status) {
  const target = innerTarget(raw);
  if (targetValue(target, status) === null) return [];
  const data = target.data || {};
  if (target.kind === "group")
    return bandsForGroup(status, data.group).map((band) => ({
      kind: "band",
      index: band.index,
      value: gainFromValue(value),
    }));
  if (target.kind === "band")
    return [{ kind: "band", index: data.index, value: gainFromValue(value) }];
  if (target.kind === "effect")
    return [
      {
        kind: "effect",
        key: data.key,
        value: Math.round(clamp01(value) * 1000) / 100,
      },
    ];
  if (target.kind === "master_gain")
    return [
      { kind: "master_gain", value: Math.round(clamp01(value) * 40 - 20) },
    ];
  if (target.kind === "power")
    return [{ kind: "power", value: clamp01(value) >= 0.5 }];
  return [];
}

export function applyWrites(status, writes) {
  if (!status) return;
  for (const write of writes) {
    if (write.kind === "band") {
      const band = status.equalizer.bands.find((b) => b.index === write.index);
      if (band) band.gain = write.value;
    } else if (write.kind === "effect") status.effects[write.key] = write.value;
    else if (write.kind === "master_gain")
      status.equalizer.master_gain = write.value;
    else if (write.kind === "power") status.power = write.value;
  }
}

export function describeLabel(raw, status) {
  const target = innerTarget(raw);
  const data = target?.data || {};
  if (target?.kind === "band") {
    const band = status?.equalizer?.bands?.find((b) => b.index === data.index);
    if (band)
      return `EQ Band ${band.index + 1} — ${frequencyLabel(band.frequency)}`;
  }
  return data.label || "FxSound";
}

export function frequencyLabel(hz) {
  return hz >= 1000
    ? `${Number((hz / 1000).toFixed(2))} kHz`
    : `${Number(hz.toFixed(2))} Hz`;
}

export function targetOptions({ controlType, nav } = {}, snapshot, icon) {
  const status = snapshot?.status;
  if (!snapshot?.connected || !status)
    return [
      {
        label: "Connect to FxSound in Plugins",
        kind: "placeholder",
        ghost: true,
      },
    ];
  const option = (kind, data, buttonLabel = null, behavior = "momentary") => ({
    label: data.label,
    icon_data: icon,
    target: { Integration: { integration_id: ID, kind, data } },
    ...(buttonLabel
      ? {
          buttonActions: [
            {
              label: buttonLabel,
              value:
                behavior === "stateful"
                  ? "ToggleEffect"
                  : "SetMainOutputDevice",
              behavior,
            },
          ],
        }
      : {}),
  });
  if (controlType === "button") {
    if (nav?.section === "presets")
      return [...status.presets.built_in, ...status.presets.user_defined].map(
        (preset) =>
          option(
            "preset",
            { name: preset.name, label: preset.name },
            "Select Preset",
          ),
      );
    return [
      option(
        "power",
        { label: "Toggle Processing" },
        "Toggle Processing",
        "stateful",
      ),
      option("reset", { label: "Reset EQ" }, "Reset EQ"),
      { label: "Presets", nav: { section: "presets" }, icon_data: icon },
    ];
  }
  if (nav?.section === "bands")
    return status.equalizer.bands.map((band) =>
      option("band", {
        index: band.index,
        label: `EQ Band ${band.index + 1} — ${frequencyLabel(band.frequency)}`,
      }),
    );
  if (nav?.section === "effects")
    return Object.entries(EFFECTS)
      .filter(([key]) => Number.isFinite(status.effects[key]))
      .map(([key, label]) => option("effect", { key, label }));
  return [
    ...GROUPS.filter((group) => bandsForGroup(status, group).length).map(
      (group) =>
        option("group", {
          group,
          label: `EQ ${group[0].toUpperCase()}${group.slice(1)}`,
        }),
    ),
    {
      label: "Individual EQ Bands",
      nav: { section: "bands" },
      icon_data: icon,
    },
    { label: "Effects", nav: { section: "effects" }, icon_data: icon },
  ];
}
