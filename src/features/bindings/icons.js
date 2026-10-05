const MUTED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m18 9-4 6M14 9l4 6"/></svg>';
const UNMUTED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';

export function muteIconSvg(muted) {
  return muted ? MUTED_ICON : UNMUTED_ICON;
}

const ACTION_ICONS = Object.freeze({
  solo: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><path d="M4 12h3v9H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2ZM20 12h-3v9h3a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2Z"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">                    <path d="M6 6l12 12M18 6 6 18"></path>                  </svg>',
  assign: '<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none"/><circle cx="9" cy="9" r="1.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m14 6 4 4"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M8 7l1 13h6l1-13"/><path d="M10.5 11v5M13.5 11v5"/></svg>',
});

export function bindingActionIconSvg(name) {
  return ACTION_ICONS[name] || "";
}
