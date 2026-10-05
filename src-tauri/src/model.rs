mod action_mappings;
mod binding_types;
mod control_types;
mod fader_outputs;
mod macro_types;
mod midi_types;
mod osd_types;
mod profile_types;
mod target_types;

#[allow(unused_imports)]
pub use binding_types::{
    normalize_macro_draft_steps, normalize_macro_steps, AssignMode, AutoHotkeyScriptMapping,
    AuxiliaryControl, Binding, BindingAction, BindingControlKind, BindingTarget,
    BindingTargetFeedbackSource, ButtonLightBehavior, ButtonLightMode, FaderCurve, FaderCurvePoint,
    FaderModifier, FaderModifierKind, FeedbackMode, HotkeyMapping, MacroActionState,
    MacroActionStep, MacroStep, MidiMode, MuteBehavior, OpenApplicationMapping, RelativeFormat,
    SoundboardMapping, MACRO_MAX_PARALLEL_STEPS, MACRO_MAX_TOP_LEVEL_STEPS, MACRO_MAX_WAIT_MS,
};
pub use fader_outputs::{FaderOutput, FaderOutputKind};
#[allow(unused_imports)]
pub use midi_types::{
    DeviceInfo, LearnedControl, MidiControl, MidiEvent, MidiMessageType, PlaybackDeviceInfo,
    SessionInfo,
};
pub use osd_types::OsdSettings;
pub use profile_types::{
    normalized_routes_with_legacy, MidiDevicePreference, MidiDeviceRoute, Profile, ProfileSummary,
    ProfileTargetState,
};

#[cfg(test)]
mod modifier_tests;
#[cfg(test)]
mod tests;
