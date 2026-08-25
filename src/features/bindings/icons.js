const MUTED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m18 9-4 6M14 9l4 6"/></svg>';
const UNMUTED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';

export function muteIconSvg(muted) {
  return muted ? MUTED_ICON : UNMUTED_ICON;
}

const ACTION_ICONS = Object.freeze({
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m14 6 4 4"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M8 7l1 13h6l1-13"/><path d="M10.5 11v5M13.5 11v5"/></svg>',
});

export function bindingActionIconSvg(name) {
  return ACTION_ICONS[name] || "";
}
