pub use super::action_mappings::*;
use super::control_types::default_feedback_enabled;
pub use super::control_types::*;
pub use super::macro_types::*;
use super::midi_types::{MidiControl, MidiMessageType};
pub use super::target_types::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub macro_name: String,
    pub device_id: String,
    pub control: MidiControl,
    #[serde(default)]
    pub control_kind: BindingControlKind,
    #[serde(default)]
    pub targets: Vec<BindingTarget>,
    #[serde(default, skip_serializing)]
    pub target: BindingTarget,
    #[serde(default)]
    pub action: BindingAction,
    pub mode: MidiMode,
    #[serde(default)]
    pub relative_format: RelativeFormat,
    #[serde(default)]
    pub fader_curve: FaderCurve,
    #[serde(default)]
    pub custom_curve: Vec<FaderCurvePoint>,
    pub deadzone: f32,
    pub debounce_ms: u64,
    #[serde(default)]
    pub mute_behavior: MuteBehavior,
    #[serde(default)]
    pub button_light_mode: ButtonLightMode,
    #[serde(default)]
    pub button_light_behavior: ButtonLightBehavior,
    #[serde(default = "default_feedback_enabled")]
    pub feedback_enabled: bool,
    #[serde(default)]
    pub indicator_control: Option<AuxiliaryControl>,
    #[serde(default)]
    pub mute_control: Option<AuxiliaryControl>,
    #[serde(default)]
    pub assign_control: Option<AuxiliaryControl>,
    #[serde(default)]
    pub assign_mode: AssignMode,
    #[serde(default)]
    pub hotkey: Option<HotkeyMapping>,
    #[serde(default)]
    pub open_application: Option<OpenApplicationMapping>,
    #[serde(default)]
    pub autohotkey_script: Option<AutoHotkeyScriptMapping>,
    #[serde(default)]
    pub soundboard: Option<SoundboardMapping>,
    #[serde(default)]
    pub macro_steps: Vec<MacroStep>,
}

impl Binding {
    pub(crate) fn strip_derived_integration_icons(&mut self) -> bool {
        fn strip_target(target: &mut BindingTarget) -> bool {
            let BindingTarget::Integration { data, .. } = target else {
                return false;
            };
            let Some(data) = data.as_object_mut() else {
                return false;
            };
            let snake = data.remove("icon_data").is_some();
            let camel = data.remove("iconData").is_some();
            snake || camel
        }

        fn strip_macro_step(step: &mut MacroStep) -> bool {
            let mut changed = false;
            match step {
                MacroStep::Action(action) => {
                    for target in &mut action.targets {
                        changed |= strip_target(target);
                    }
                }
                MacroStep::Parallel { steps } => {
                    for target in steps.iter_mut().flat_map(|step| step.targets.iter_mut()) {
                        changed |= strip_target(target);
                    }
                }
                MacroStep::Wait { .. } => {}
            }
            changed
        }

        let mut changed = strip_target(&mut self.target);
        for target in &mut self.targets {
            changed |= strip_target(target);
        }
        for step in &mut self.macro_steps {
            changed |= strip_macro_step(step);
        }
        changed
    }

    pub fn normalize_button_light_serialization(&mut self) -> bool {
        let before_mode = self.button_light_mode.clone();
        let before_behavior = self.button_light_behavior.clone();
        match self.button_light_mode.clone() {
            ButtonLightMode::Activity | ButtonLightMode::MappedWhenAssigned => {}
            ButtonLightMode::FollowState => {
                self.button_light_mode = ButtonLightMode::Activity;
                self.button_light_behavior = ButtonLightBehavior::FollowState;
            }
            ButtonLightMode::InvertState => {
                self.button_light_mode = ButtonLightMode::Activity;
                self.button_light_behavior = ButtonLightBehavior::InvertState;
            }
            ButtonLightMode::Pressed => {
                self.button_light_mode = ButtonLightMode::Activity;
                self.button_light_behavior = ButtonLightBehavior::Pressed;
            }
        }
        self.button_light_mode != before_mode || self.button_light_behavior != before_behavior
    }

    fn effective_button_light_behavior(&self) -> ButtonLightBehavior {
        match &self.button_light_mode {
            ButtonLightMode::FollowState => ButtonLightBehavior::FollowState,
            ButtonLightMode::InvertState => ButtonLightBehavior::InvertState,
            ButtonLightMode::Pressed => ButtonLightBehavior::Pressed,
            ButtonLightMode::Activity | ButtonLightMode::MappedWhenAssigned => {
                self.button_light_behavior.clone()
            }
        }
    }

    pub fn is_button_binding(&self) -> bool {
        matches!(self.control_kind, BindingControlKind::Button)
            || (matches!(self.control_kind, BindingControlKind::Auto)
                && matches!(
                    self.control.msg_type,
                    MidiMessageType::Note | MidiMessageType::ProgramChange
                ))
    }

    pub fn mapped_button_light_feedback_value(&self) -> Option<f32> {
        self.mapped_button_light_feedback_value_with_availability(|_| true)
    }

    pub fn mapped_button_light_feedback_value_with_availability(
        &self,
        target_is_available: impl Fn(&BindingTarget) -> bool,
    ) -> Option<f32> {
        if !self.feedback_enabled
            || !self.is_button_binding()
            || !matches!(&self.button_light_mode, ButtonLightMode::MappedWhenAssigned)
        {
            return None;
        }

        let targets = self.normalized_targets_ref();
        if !targets
            .iter()
            .any(|target| !matches!(target, BindingTarget::Unset))
        {
            return Some(0.0);
        }

        Some(
            if self.has_complete_mapped_button_light_target_with_availability(
                targets,
                &target_is_available,
            ) {
                1.0
            } else {
                0.0
            },
        )
    }

    pub fn custom_feedback_output_control(&self) -> Option<&AuxiliaryControl> {
        let control = self.indicator_control.as_ref()?;
        match control.msg_type {
            MidiMessageType::ControlChange | MidiMessageType::Note => Some(control),
            MidiMessageType::PitchBend if !self.is_button_binding() => Some(control),
            MidiMessageType::PitchBend | MidiMessageType::ProgramChange => None,
        }
    }

    pub fn indicator_feedback_control(&self) -> Option<&AuxiliaryControl> {
        if !self.is_button_binding() {
            return None;
        }

        let control = self.indicator_control.as_ref()?;
        match control.msg_type {
            MidiMessageType::ControlChange | MidiMessageType::Note => Some(control),
            MidiMessageType::PitchBend | MidiMessageType::ProgramChange => None,
        }
    }

    pub fn button_light_feedback_value(
        &self,
        input_active: Option<bool>,
        state_active: Option<bool>,
    ) -> Option<f32> {
        if !self.feedback_enabled || !self.is_button_binding() {
            return None;
        }

        if let Some(value) = self.mapped_button_light_feedback_value() {
            return Some(value);
        }

        let targets = self.normalized_targets_ref();
        if !targets
            .iter()
            .any(|target| !matches!(target, BindingTarget::Unset))
        {
            return None;
        }

        let input_active = input_active.unwrap_or(false);
        let active = match self.effective_button_light_behavior() {
            ButtonLightBehavior::FollowState => state_active.unwrap_or(input_active),
            ButtonLightBehavior::InvertState => match state_active {
                Some(active) => !active,
                None => !input_active,
            },
            ButtonLightBehavior::Pressed => input_active,
        };

        Some(if active { 1.0 } else { 0.0 })
    }

    #[allow(dead_code)]
    pub fn has_complete_mapped_button_light_target(&self, targets: &[BindingTarget]) -> bool {
        self.has_complete_mapped_button_light_target_with_availability(targets, &|_| true)
    }

    fn has_complete_mapped_button_light_target_with_availability(
        &self,
        targets: &[BindingTarget],
        target_is_available: &impl Fn(&BindingTarget) -> bool,
    ) -> bool {
        macro_rules! available_targets {
            () => {
                targets.iter().filter(|target| target_is_available(target))
            };
        }
        match self.action {
            BindingAction::OpenApplication => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::OpenApplication))
                    && self
                        .open_application
                        .as_ref()
                        .map(|mapping| !mapping.path.trim().is_empty())
                        .unwrap_or(false)
            }
            BindingAction::Hotkey => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::Hotkey))
                    && self
                        .hotkey
                        .as_ref()
                        .map(|mapping| !mapping.keys.is_empty())
                        .unwrap_or(false)
            }
            BindingAction::RunAutoHotkeyScript => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::AutoHotkeyScript))
                    && self
                        .autohotkey_script
                        .as_ref()
                        .map(|mapping| !mapping.path.trim().is_empty())
                        .unwrap_or(false)
            }
            BindingAction::Macro => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::Macro))
                    && !normalize_macro_steps(&self.macro_steps).is_empty()
            }
            BindingAction::Soundboard => {
                available_targets!()
                    .any(|target| matches!(target, BindingTarget::Soundboard))
                    && self
                        .soundboard
                        .as_ref()
                        .and_then(SoundboardMapping::normalized)
                        .is_some()
            }
            BindingAction::MediaPlayPause
            | BindingAction::MediaNextTrack
            | BindingAction::MediaPrevTrack
            | BindingAction::MediaStop => available_targets!()
                .any(|target| matches!(target, BindingTarget::MediaControl)),
            BindingAction::FocusWindow => available_targets!().any(|target| {
                matches!(
                    target,
                    BindingTarget::Application { name, .. } if !name.trim().is_empty()
                )
            }),
            BindingAction::FullScreenshot
            | BindingAction::SnipScreenshot
            | BindingAction::ToggleScreenRecording => available_targets!()
                .any(|target| matches!(target, BindingTarget::CaptureControl)),
            BindingAction::SetDefaultDevice => available_targets!().any(|target| {
                matches!(
                    target,
                    BindingTarget::Device { device_id } if !device_id.trim().is_empty()
                )
            }),
            BindingAction::SwitchProfile => available_targets!().any(|target| {
                matches!(target, BindingTarget::Profile { name } if !name.trim().is_empty())
            }),
            BindingAction::SetMainOutputDevice => available_targets!()
                .any(Self::target_is_complete_for_mapped_light),
            BindingAction::Volume | BindingAction::ToggleMute | BindingAction::ToggleEffect => {
                available_targets!()
                    .any(Self::target_is_complete_for_mapped_light)
            }
        }
    }

    pub fn uses_stateful_toggle_feedback(&self) -> bool {
        matches!(
            self.action,
            BindingAction::ToggleMute | BindingAction::ToggleEffect
        ) || self
            .normalized_targets_ref()
            .iter()
            .any(Self::target_uses_stateful_toggle_feedback)
    }

    fn target_uses_stateful_toggle_feedback(target: &BindingTarget) -> bool {
        let BindingTarget::Integration {
            integration_id,
            kind,
            data,
        } = target
        else {
            return false;
        };

        if data
            .get("action_kind")
            .and_then(|value| value.as_str())
            .map(|value| value.eq_ignore_ascii_case("stateful"))
            .unwrap_or(false)
        {
            return true;
        }

        integration_id.eq_ignore_ascii_case("obs")
            && kind.eq_ignore_ascii_case("action")
            && data
                .get("action")
                .and_then(|value| value.as_str())
                .map(|value| value.starts_with("Toggle"))
                .unwrap_or(false)
    }

    fn target_is_complete_for_mapped_light(target: &BindingTarget) -> bool {
        match target {
            BindingTarget::Unset => false,
            BindingTarget::Master
            | BindingTarget::Focus
            | BindingTarget::MonitorBrightness { .. }
            | BindingTarget::MediaControl
            | BindingTarget::CaptureControl
            | BindingTarget::Macro
            | BindingTarget::Soundboard => true,
            BindingTarget::Session { session_id } => !session_id.trim().is_empty(),
            BindingTarget::Application { name, .. } => !name.trim().is_empty(),
            BindingTarget::Device { device_id } => !device_id.trim().is_empty(),
            BindingTarget::Profile { name } => !name.trim().is_empty(),
            BindingTarget::Integration {
                integration_id,
                kind,
                ..
            } => !integration_id.trim().is_empty() && !kind.trim().is_empty(),
            BindingTarget::Hotkey | BindingTarget::OpenApplication => false,
            BindingTarget::AutoHotkeyScript => false,
        }
    }

    pub fn normalized_targets(&self) -> Vec<BindingTarget> {
        if !self.targets.is_empty() {
            self.targets.clone()
        } else if self.target != BindingTarget::Unset {
            vec![self.target.clone()]
        } else {
            Vec::new()
        }
    }

    /// Returns the effective targets without cloning their integration metadata.
    pub fn normalized_targets_ref(&self) -> &[BindingTarget] {
        if !self.targets.is_empty() {
            &self.targets
        } else if self.target != BindingTarget::Unset {
            std::slice::from_ref(&self.target)
        } else {
            &[]
        }
    }

    pub fn primary_target(&self) -> BindingTarget {
        self.normalized_targets()
            .into_iter()
            .next()
            .unwrap_or(BindingTarget::Unset)
    }

    pub fn primary_target_ref(&self) -> &BindingTarget {
        self.normalized_targets_ref()
            .first()
            .unwrap_or(&self.target)
    }

    pub fn ensure_targets(&mut self) {
        if self.targets.is_empty() && self.target != BindingTarget::Unset {
            self.targets.push(self.target.clone());
        }
        let preferred_special = match self.action {
            BindingAction::Macro => Some(BindingTarget::Macro),
            BindingAction::Soundboard => Some(BindingTarget::Soundboard),
            _ => None,
        };
        let mut selected_special: Option<BindingTarget> = None;
        self.targets.retain(|target| match target {
            BindingTarget::Macro | BindingTarget::Soundboard => {
                if preferred_special
                    .as_ref()
                    .is_some_and(|preferred| preferred != target)
                    || selected_special.is_some()
                {
                    false
                } else {
                    selected_special = Some(target.clone());
                    true
                }
            }
            _ => true,
        });
        if self.targets.len() > 1 {
            self.targets.retain(|t| *t != BindingTarget::Unset);
        }
        if self.targets.len() > 8 {
            self.targets.truncate(8);
        }
        selected_special = self
            .targets
            .iter()
            .find(|target| matches!(target, BindingTarget::Macro | BindingTarget::Soundboard))
            .cloned();
        if let Some(preferred) = preferred_special {
            if selected_special.is_none() {
                if self.targets.len() >= 8 {
                    self.targets.truncate(7);
                }
                self.targets.push(preferred.clone());
                selected_special = Some(preferred);
            }
        }
        if let Some(first) = self.targets.first().cloned() {
            self.target = first;
        } else {
            self.target = BindingTarget::Unset;
        }
        self.macro_steps = if matches!(self.action, BindingAction::Macro)
            || self
                .targets
                .iter()
                .any(|target| matches!(target, BindingTarget::Macro))
        {
            normalize_macro_draft_steps(&self.macro_steps)
        } else {
            normalize_macro_steps(&self.macro_steps)
        };
        if !matches!(selected_special, Some(BindingTarget::Macro)) {
            self.macro_name.clear();
            self.macro_steps.clear();
        }
        self.soundboard = self
            .soundboard
            .as_ref()
            .and_then(SoundboardMapping::normalized);
        if !matches!(selected_special, Some(BindingTarget::Soundboard)) {
            self.soundboard = None;
        }
    }
}
