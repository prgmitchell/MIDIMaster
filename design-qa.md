# Fader configuration design QA

Final result: passed

No actionable P0, P1, or P2 visual findings remain. The user accepted the revised screen on 2026-10-05. The existing window dimensions and application components take precedence over the larger mockup.

## Evidence

- Source visual truth: `C:/Users/Mitchell/AppData/Local/Temp/codex-clipboard-5e49ec35-1db4-4698-85a1-400428f1ee99.png`, 1654 × 951 pixels. The source modal occupies approximately 1451 × 917 pixels; its CSS viewport and device density are unknown.
- Browser-rendered implementation: `C:/Users/Mitchell/.codex/visualizations/2026/10/05/01a10d9d-213b-7b52-a580-81aae3969999/fader-configuration-dark.jpg`, 1480 × 820 pixels, CSS viewport 1480 × 820, deviceScaleFactor 1. State: fader configuration open, three mapped modifiers, dark theme.
- Full comparison: `C:/Users/Mitchell/.codex/visualizations/2026/10/05/01a10d9d-213b-7b52-a580-81aae3969999/fader-comparison-full.png`. Modal crops are normalized to the same 1160-pixel width with proportional height; image padding and the source's larger window are excluded from findings.
- Focused modifiers comparison: `C:/Users/Mitchell/.codex/visualizations/2026/10/05/01a10d9d-213b-7b52-a580-81aae3969999/fader-comparison-modifiers.png`. Shows list hierarchy, icons, mapping text, shared dropdowns, and row actions at readable size.
- Open dropdown: `C:/Users/Mitchell/.codex/visualizations/2026/10/05/01a10d9d-213b-7b52-a580-81aae3969999/fader-solo-dropdown.jpg`.
- Automatic Learn: `C:/Users/Mitchell/.codex/visualizations/2026/10/05/01a10d9d-213b-7b52-a580-81aae3969999/fader-add-learn.jpg`. Learn opens immediately; the pending modifier does not appear in the list.
- Legacy/light theme: `C:/Users/Mitchell/.codex/visualizations/2026/10/05/01a10d9d-213b-7b52-a580-81aae3969999/fader-legacy-light.jpg`. Only the assigned legacy Mute and Assign controls appear.
- Responsive capture: `C:/Users/Mitchell/.codex/visualizations/2026/10/05/01a10d9d-213b-7b52-a580-81aae3969999/fader-responsive.jpg`, 844 × 798 CSS/pixels, density 1. Single column, scrollable body, footer remains visible. Temporary viewport override was reset after testing.

## Required fidelity surfaces

| Surface | Assessment |
| --- | --- |
| Fonts and typography | Existing Bahnschrift/Aptos/Segoe UI stack retained. Section, row-title, mapping, and live-value hierarchy are consistent with the application. Mapping text fits/truncates within its column. The mockup's larger text scale is intentionally compressed within the unchanged application window. Captures at the enlarged preview viewport are softer than the supplied source; this is a capture limitation, not a font substitution. |
| Spacing and layout rhythm | Name, Curve, Feedback, and LED remain on the left; Live and Modifiers are on the right. Desktop modal measures exactly 1160 × 780. Its body is 682 pixels tall without overflow at 1480 × 820; the modifier list scrolls internally (174 visible / 216 content pixels). Existing radii, section gaps, and pinned footer are retained. At 844 × 798 the modal is 810.23 × 778 and its body scrolls independently of the footer. |
| Colors and tokens | Existing dark/light appearance tokens, blue primary buttons, red Mute, and yellow Solo icons are reused. Both themes were inspected. Dropdown menus use the same select components and color tokens as the rest of the application. |
| Image quality and assets | Existing curve renderer, fader preview, application target-icon pipeline, and standard application SVG icon style are retained. No decorative raster assets are introduced. The isolated preview fixture omits a provider target icon; production still uses the existing target-icon pipeline. Source/implementation crops were compared without replacing source content. |
| Copy and content | Mockup section names/help are retained, with Solo included in modifier help. Unmapped modifiers are intentionally absent, including the mockup's unassigned Assign row. Add starts the application's existing MIDI Learn panel; cancellation discards the pending modifier. Modifier behavior and Solo tooltips are locale keys. |

## Comparison history and fixes

1. The initial layout needed to fit the existing 1160 × 780 window while keeping the footer and output controls accessible. Grid rows and internal scrolling were adjusted. The final desktop and responsive captures confirm this.
2. The first modifier behavior select looked inconsistent with the application. It was replaced with the shared select dropdown component. The open-dropdown capture and selection interaction confirm the fix.
3. Pending modifier rows could initially display “Not mapped.” Add now starts Learn immediately, renders mapped rows only, and discards unmapped drafts on cancellation or Learn failure. Browser evidence shows no extra row during Learn and three rows after cancellation; workflow tests cover successful learning and transfer cancellation.

## Verification and remaining test gaps

- Browser interactions: Add menu choices, immediate Solo Learn, Learn cancellation via close, dropdown Toggle/Match selection, legacy migration, dark/light themes, and responsive layout.
- Browser console: no warning/error entries during the verified preview states.
- Automated checks: all 80 frontend test scripts; Rust library suite (361 passed, four ignored); architecture checks; generated plugin consistency. Live Windows source inventory was read without changing audio.
- Live MIDI presses and audible Windows/Wave Link isolation/restoration have not been exercised. They remain a hardware verification gap; the isolated preview does not control real audio.

## Implementation checklist

- [x] Keep the existing configuration window dimensions.
- [x] Render a reorderable list of mapped modifiers and migrate assigned legacy slots.
- [x] Use shared application dropdowns.
- [x] Add Solo with Windows/Wave Link snapshots and restoration.
- [x] Start Learn on Add and discard cancelled/unmapped modifiers.
- [x] Inspect full and focused comparisons and test responsive/footer behavior.

Follow-up polish: none required for the accepted design.
