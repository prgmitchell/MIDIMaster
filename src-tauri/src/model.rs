mod binding_types;
mod midi_types;
mod osd_types;
mod profile_types;

#[allow(unused_imports)]
pub use binding_types::{
    AssignMode, AutoHotkeyScriptMapping, AuxiliaryControl, Binding, BindingAction,
    BindingControlKind, BindingTarget, ButtonLightMode, FaderCurve, FaderCurvePoint, HotkeyMapping,
    MidiMode, MuteBehavior, OpenApplicationMapping, RelativeFormat,
};
#[allow(unused_imports)]
pub use midi_types::{
    DeviceInfo, LearnedControl, MidiControl, MidiEvent, MidiMessageType, PlaybackDeviceInfo,
    SessionInfo,
};
pub use osd_types::OsdSettings;
pub use profile_types::{
    normalized_routes_with_legacy, MidiDevicePreference, MidiDeviceRoute, Profile, ProfileSummary,
};

#[cfg(test)]
mod tests;
