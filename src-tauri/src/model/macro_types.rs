use super::{
    AutoHotkeyScriptMapping, BindingAction, BindingTarget, HotkeyMapping, OpenApplicationMapping,
};
use serde::{Deserialize, Serialize};

pub const MACRO_MAX_TOP_LEVEL_STEPS: usize = 25;
pub const MACRO_MAX_PARALLEL_STEPS: usize = 8;
pub const MACRO_MAX_WAIT_MS: u64 = 60_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum MacroActionState {
    #[default]
    Default,
    Toggle,
    On,
    Off,
    Mute,
    Unmute,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MacroActionStep {
    pub action: BindingAction,
    pub targets: Vec<BindingTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f32>,
    #[serde(default)]
    pub state: MacroActionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<HotkeyMapping>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_application: Option<OpenApplicationMapping>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autohotkey_script: Option<AutoHotkeyScriptMapping>,
}

impl Default for MacroActionStep {
    fn default() -> Self {
        Self {
            action: BindingAction::Volume,
            targets: Vec::new(),
            value: None,
            state: MacroActionState::Default,
            action_role: None,
            action_label: None,
            value_kind: None,
            hotkey: None,
            open_application: None,
            autohotkey_script: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MacroStep {
    Action(Box<MacroActionStep>),
    Wait { duration_ms: u64 },
    Parallel { steps: Vec<MacroActionStep> },
}

impl MacroStep {
    pub fn normalized(&self) -> Option<Self> {
        match self {
            MacroStep::Action(step) => {
                normalize_macro_action_step(step).map(|step| MacroStep::Action(Box::new(step)))
            }
            MacroStep::Wait { duration_ms } => Some(MacroStep::Wait {
                duration_ms: (*duration_ms).min(MACRO_MAX_WAIT_MS),
            }),
            MacroStep::Parallel { steps } => {
                let normalized: Vec<MacroActionStep> = steps
                    .iter()
                    .filter_map(normalize_macro_action_step)
                    .take(MACRO_MAX_PARALLEL_STEPS)
                    .collect();
                if normalized.is_empty() {
                    None
                } else {
                    Some(MacroStep::Parallel { steps: normalized })
                }
            }
        }
    }

    pub fn normalized_draft(&self) -> Option<Self> {
        match self {
            MacroStep::Action(step) => normalize_macro_draft_action_step(step)
                .map(|step| MacroStep::Action(Box::new(step))),
            MacroStep::Wait { duration_ms } => Some(MacroStep::Wait {
                duration_ms: (*duration_ms).min(MACRO_MAX_WAIT_MS),
            }),
            MacroStep::Parallel { steps } => {
                let normalized: Vec<MacroActionStep> = steps
                    .iter()
                    .filter_map(normalize_macro_draft_action_step)
                    .take(MACRO_MAX_PARALLEL_STEPS)
                    .collect();
                Some(MacroStep::Parallel { steps: normalized })
            }
        }
    }
}

pub fn normalize_macro_steps(steps: &[MacroStep]) -> Vec<MacroStep> {
    steps
        .iter()
        .filter_map(MacroStep::normalized)
        .take(MACRO_MAX_TOP_LEVEL_STEPS)
        .collect()
}

pub fn normalize_macro_draft_steps(steps: &[MacroStep]) -> Vec<MacroStep> {
    steps
        .iter()
        .filter_map(MacroStep::normalized_draft)
        .take(MACRO_MAX_TOP_LEVEL_STEPS)
        .collect()
}

fn normalize_macro_action_step(step: &MacroActionStep) -> Option<MacroActionStep> {
    if matches!(
        step.action,
        BindingAction::Macro | BindingAction::Soundboard
    ) {
        return None;
    }

    let targets: Vec<BindingTarget> = step
        .targets
        .iter()
        .filter(|target| {
            !matches!(
                target,
                BindingTarget::Unset | BindingTarget::Macro | BindingTarget::Soundboard
            )
        })
        .take(8)
        .cloned()
        .collect();

    if targets.is_empty() {
        return None;
    }

    Some(MacroActionStep {
        action: step.action.clone(),
        targets,
        value: step.value.map(|value| value.clamp(0.0, 1.0)),
        state: step.state.clone(),
        action_role: normalize_macro_action_text(step.action_role.as_deref()),
        action_label: normalize_macro_action_text(step.action_label.as_deref()),
        value_kind: normalize_macro_action_text(step.value_kind.as_deref()),
        hotkey: step.hotkey.clone(),
        open_application: step.open_application.clone(),
        autohotkey_script: step.autohotkey_script.clone(),
    })
}

fn normalize_macro_draft_action_step(step: &MacroActionStep) -> Option<MacroActionStep> {
    let is_nested_macro_action = matches!(
        step.action,
        BindingAction::Macro | BindingAction::Soundboard
    );
    let action = if is_nested_macro_action {
        BindingAction::Volume
    } else {
        step.action.clone()
    };
    let targets: Vec<BindingTarget> = if is_nested_macro_action {
        Vec::new()
    } else {
        step.targets
            .iter()
            .filter(|target| {
                !matches!(
                    target,
                    BindingTarget::Unset | BindingTarget::Macro | BindingTarget::Soundboard
                )
            })
            .take(8)
            .cloned()
            .collect()
    };

    Some(MacroActionStep {
        action,
        targets,
        value: step.value.map(|value| value.clamp(0.0, 1.0)),
        state: step.state.clone(),
        action_role: normalize_macro_action_text(step.action_role.as_deref()),
        action_label: normalize_macro_action_text(step.action_label.as_deref()),
        value_kind: normalize_macro_action_text(step.value_kind.as_deref()),
        hotkey: step.hotkey.clone(),
        open_application: step.open_application.clone(),
        autohotkey_script: step.autohotkey_script.clone(),
    })
}

fn normalize_macro_action_text(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(80).collect())
    }
}
