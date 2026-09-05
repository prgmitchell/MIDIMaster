//! Test builders only. Scenarios override controls, targets, actions and relevant state explicitly.
use crate::{model, model::Binding};

pub fn binding() -> Binding {
    Binding {
        id: "b1".to_string(),
        name: "Binding 1".to_string(),
        macro_name: String::new(),
        device_id: "midi-dev".to_string(),
        control: model::MidiControl {
            channel: 0,
            controller: 7,
            msg_type: model::MidiMessageType::ControlChange,
        },
        control_kind: model::BindingControlKind::Continuous,
        targets: vec![model::BindingTarget::Master],
        target: model::BindingTarget::Unset,
        action: model::BindingAction::Volume,
        mode: model::MidiMode::Absolute,
        relative_format: model::RelativeFormat::Auto,
        fader_curve: model::FaderCurve::Linear,
        custom_curve: Vec::new(),
        deadzone: 0.0,
        debounce_ms: 0,
        mute_behavior: model::MuteBehavior::ToggleOnPress,
        button_light_mode: model::ButtonLightMode::Activity,
        button_light_behavior: model::ButtonLightBehavior::FollowState,
        feedback_enabled: true,
        indicator_control: None,
        mute_control: None,
        assign_control: None,
        assign_mode: model::AssignMode::Add,
        hotkey: None,
        open_application: None,
        autohotkey_script: None,
        soundboard: None,
        macro_steps: Vec::new(),
    }
}
