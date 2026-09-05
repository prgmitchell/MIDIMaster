/** Value models for hotkeys and executable/script targets. */
const HOTKEY_MODIFIERS = new Set(["Ctrl", "Shift", "Alt", "Meta"]);
const HOTKEY_CODE_KEYS = new Map(
  Object.entries({
    Space: "Space",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Backquote: "Backquote",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    NumpadDecimal: "NumpadDecimal",
    NumpadAdd: "NumpadAdd",
    NumpadSubtract: "NumpadSubtract",
    NumpadMultiply: "NumpadMultiply",
    NumpadDivide: "NumpadDivide",
    NumpadEnter: "NumpadEnter",
  }),
);
const HOTKEY_KEY_ALIASES = new Map(
  Object.entries({
    " ": "Space",
    ",": "Comma",
    "<": "Comma",
    ".": "Period",
    ">": "Period",
    "/": "Slash",
    "?": "Slash",
    ";": "Semicolon",
    ":": "Semicolon",
    "'": "Quote",
    '"': "Quote",
    "`": "Backquote",
    "~": "Backquote",
    "-": "Minus",
    _: "Minus",
    "=": "Equal",
    "+": "Equal",
    "[": "BracketLeft",
    "{": "BracketLeft",
    "]": "BracketRight",
    "}": "BracketRight",
    "\\": "Backslash",
    "|": "Backslash",
    "!": "1",
    "@": "2",
    "#": "3",
    $: "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
    ")": "0",
  }),
);

function normalizeHotkeyCode(code) {
  const value = String(code || "").trim();
  if (!value) return null;
  const letterMatch = /^Key([A-Z])$/.exec(value);
  if (letterMatch) return letterMatch[1];
  const digitMatch = /^Digit([0-9])$/.exec(value);
  if (digitMatch) return digitMatch[1];
  const numpadDigitMatch = /^Numpad([0-9])$/.exec(value);
  if (numpadDigitMatch) return `Numpad${numpadDigitMatch[1]}`;
  return HOTKEY_CODE_KEYS.get(value) || null;
}

export function normalizeHotkeyKeyFromEvent(event) {
  const key = String(event?.key || "").trim();
  const lower = key.toLowerCase();
  if (lower === "control") return "Ctrl";
  if (lower === "shift") return "Shift";
  if (lower === "alt") return "Alt";
  if (lower === "meta") return "Meta";

  const codeKey = normalizeHotkeyCode(event?.code);
  if (codeKey) return codeKey;
  if (!key) return null;

  if (lower === "escape") return "Esc";
  if (lower === "arrowup") return "Up";
  if (lower === "arrowdown") return "Down";
  if (lower === "arrowleft") return "Left";
  if (lower === "arrowright") return "Right";
  if (HOTKEY_KEY_ALIASES.has(key)) return HOTKEY_KEY_ALIASES.get(key);
  if (key.length === 1) return key.toUpperCase();
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
  return key.length <= 16 ? key[0].toUpperCase() + key.slice(1) : null;
}

function hotkeyKeyIsModifier(key) {
  return HOTKEY_MODIFIERS.has(key);
}

export function buildHotkeyMappingFromEvent(event) {
  const key = normalizeHotkeyKeyFromEvent(event);
  if (!key || hotkeyKeyIsModifier(key)) return null;

  const keys = [];
  if (event?.ctrlKey) keys.push("Ctrl");
  if (event?.shiftKey) keys.push("Shift");
  if (event?.altKey) keys.push("Alt");
  if (event?.metaKey) keys.push("Meta");
  if (!keys.includes(key)) keys.push(key);

  return {
    keys,
    display: keys.join("+"),
  };
}

export function normalizeHotkeyMapping(rawHotkey) {
  if (!rawHotkey || typeof rawHotkey !== "object") return null;
  const keys = Array.isArray(rawHotkey.keys)
    ? rawHotkey.keys.map((key) => String(key || "").trim()).filter(Boolean)
    : [];
  if (keys.length === 0) return null;
  const display = String(rawHotkey.display || "").trim() || keys.join("+");
  return { keys, display };
}

export function normalizeOpenApplicationMapping(rawOpenApplication) {
  if (!rawOpenApplication || typeof rawOpenApplication !== "object") return null;
  const path = String(rawOpenApplication.path || "").trim();
  const display = String(rawOpenApplication.display || "").trim();
  const icon_data =
    typeof rawOpenApplication.icon_data === "string" && rawOpenApplication.icon_data.trim()
      ? rawOpenApplication.icon_data.trim()
      : null;
  return path ? { path, display: display || path, icon_data } : null;
}

export function normalizeAutoHotkeyScriptMapping(rawScript) {
  if (!rawScript || typeof rawScript !== "object") return null;
  const path = String(rawScript.path || "").trim();
  const display = String(rawScript.display || "").trim();
  return path ? { path, display: display || path } : null;
}
