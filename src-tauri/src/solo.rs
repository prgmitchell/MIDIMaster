//! Temporary playback isolation. The saved mute states live only for this Solo.
#[cfg(test)]
mod tests;
use crate::audio::{
    target_match::{application_name_matches, ApplicationMatchInfo},
    AudioBackend, SoloAudioSource,
};
use crate::model::{Binding, BindingTarget, FaderModifierKind, PlaybackDeviceInfo};
use crate::{feedback, AppState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct SoloRpc {
    method: String,
    params: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct WaveLinkSoloPlan {
    ws_id: u64,
    apply: Vec<SoloRpc>,
    restore: Vec<SoloRpc>,
    #[serde(default)]
    allow_virtual_inputs: bool,
    #[serde(default)]
    virtual_channel_ids: Vec<String>,
}

#[derive(Default)]
pub(crate) struct SoloRuntime(Mutex<Option<ActiveSolo>>);

struct ActiveSolo {
    restoring: bool,
    binding: Binding,
    targets: Vec<BindingTarget>,
    focused_id: Option<String>,
    default_device_id: Option<String>,
    originals: HashMap<String, bool>,
    wave_link: Option<WaveLinkSoloPlan>,
}

#[derive(Serialize)]
pub(crate) struct SoloContext {
    active_binding_id: Option<String>,
    targets: Vec<BindingTarget>,
    wave_link_channel_ids: Vec<String>,
}

fn matches_application(source: &SoloAudioSource, name: &str) -> bool {
    let s = &source.session;
    application_name_matches(
        name,
        ApplicationMatchInfo {
            process_path: s.process_path.as_deref(),
            process_name: s.process_name.as_deref(),
            display_name: Some(&s.display_name),
            application_key: s.application_key.as_deref(),
            ..Default::default()
        },
    )
}

fn selected(
    source: &SoloAudioSource,
    targets: &[BindingTarget],
    focused_id: Option<&str>,
    default_id: Option<&str>,
) -> bool {
    let matches_session = |id: &str| {
        source.session.id == id
            || (default_id == Some(source.device_id.as_str())
                && source
                    .session
                    .id
                    .strip_prefix(&format!("{}|", source.device_id))
                    == Some(id))
    };
    targets.iter().any(|target| match target {
        BindingTarget::Application { name, .. } => matches_application(source, name),
        BindingTarget::Session { session_id } => matches_session(session_id),
        BindingTarget::Focus => focused_id.is_some_and(matches_session),
        BindingTarget::Device { device_id } => {
            let (kind, id) = crate::device_target::parse_device_target(device_id);
            kind == crate::device_target::DeviceTargetKind::Playback && source.device_id == id
        }
        BindingTarget::Master => default_id == Some(source.device_id.as_str()),
        _ => false,
    })
}

fn desired_mute(active: &ActiveSolo, source: &SoloAudioSource) -> bool {
    if selected(
        source,
        &active.targets,
        active.focused_id.as_deref(),
        active.default_device_id.as_deref(),
    ) {
        // An entire output keeps its existing mix; an individual source becomes audible.
        if active
            .targets
            .iter()
            .any(|target| matches!(target, BindingTarget::Master | BindingTarget::Device { .. }))
        {
            return *active
                .originals
                .get(&source.session.id)
                .unwrap_or(&source.session.is_muted);
        }
        return false;
    }
    if let Some(plan) = &active.wave_link {
        let engine = ["Elgato.WaveLink", "WaveLink", "WavelinkSEService"]
            .iter()
            .any(|name| matches_application(source, name));
        if engine {
            return false;
        }
        if plan.allow_virtual_inputs
            && source.wave_link_channel_id.as_ref().is_some_and(|id| {
                plan.virtual_channel_ids
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(id))
            })
        {
            return *active
                .originals
                .get(&source.session.id)
                .unwrap_or(&source.session.is_muted);
        }
    }
    true
}

fn apply_sources(audio: &dyn AudioBackend, active: &mut ActiveSolo) -> Result<(), String> {
    for source in audio.list_solo_sources().map_err(|e| e.to_string())? {
        active
            .originals
            .entry(source.session.id.clone())
            .or_insert(source.session.is_muted);
        let next = desired_mute(active, &source);
        if source.session.is_muted != next {
            audio
                .set_session_mute(&source.session.id, next)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn restore_sources(audio: &dyn AudioBackend, active: &ActiveSolo) -> Result<(), String> {
    let live: HashSet<_> = audio
        .list_solo_sources()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|s| s.session.id)
        .collect();
    let mut errors = Vec::new();
    for (id, muted) in &active.originals {
        if live.contains(id) {
            if let Err(error) = audio.set_session_mute(id, *muted) {
                errors.push(error.to_string());
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn binding(state: &AppState, binding_id: &str) -> Result<Binding, String> {
    state
        .active_profile
        .lock()
        .map_err(|_| "Profile lock poisoned")?
        .as_ref()
        .and_then(|profile| {
            profile
                .bindings
                .iter()
                .find(|binding| binding.id == binding_id)
        })
        .cloned()
        .filter(|binding| {
            binding
                .modifier_controls()
                .any(|(kind, _, _)| kind == FaderModifierKind::Solo)
        })
        .ok_or_else(|| "This binding no longer has an assigned Solo modifier".to_string())
}

fn selection_context(
    audio: &dyn AudioBackend,
) -> Result<(Option<String>, Vec<PlaybackDeviceInfo>), String> {
    Ok((
        audio
            .focused_session_state()
            .map_err(|e| e.to_string())?
            .map(|s| s.id),
        audio.list_playback_devices().map_err(|e| e.to_string())?,
    ))
}

impl SoloRuntime {
    pub(crate) fn is_active(&self) -> bool {
        self.0.lock().map(|guard| guard.is_some()).unwrap_or(false)
    }

    pub(crate) fn valid_in(&self, profile: &crate::model::Profile) -> bool {
        self.0
            .lock()
            .map(|guard| {
                guard.as_ref().is_none_or(|active| {
                    !active.restoring && {
                        profile.bindings.iter().any(|binding| {
                            binding.id == active.binding.id
                                && binding.normalized_targets() == active.targets
                                && binding
                                    .modifier_controls()
                                    .any(|(kind, _, _)| kind == FaderModifierKind::Solo)
                                && binding
                                    .modifier_controls()
                                    .filter(|(kind, _, _)| *kind == FaderModifierKind::Solo)
                                    .map(|(_, control, _)| control)
                                    .eq(active
                                        .binding
                                        .modifier_controls()
                                        .filter(|(kind, _, _)| *kind == FaderModifierKind::Solo)
                                        .map(|(_, control, _)| control))
                        })
                    }
                })
            })
            .unwrap_or(false)
    }

    pub(crate) fn send_feedback(&self, state: &AppState, binding: &Binding) {
        let active = self
            .0
            .lock()
            .map(|guard| {
                guard
                    .as_ref()
                    .is_some_and(|active| active.binding.id == binding.id)
            })
            .unwrap_or(false);
        send_lights(state, binding, active);
    }
    pub(crate) fn context(
        &self,
        state: &AppState,
        binding_id: &str,
    ) -> Result<SoloContext, String> {
        let binding = binding(state, binding_id)?;
        let targets = binding.normalized_targets();
        let (focus, devices) = selection_context(state.audio.as_ref())?;
        let default = devices.iter().find(|d| d.is_default).map(|d| d.id.as_str());
        let wave_link_channel_ids = state
            .audio
            .list_solo_sources()
            .map_err(|e| e.to_string())?
            .iter()
            .filter(|s| selected(s, &targets, focus.as_deref(), default))
            .filter_map(|s| s.wave_link_channel_id.clone())
            .collect();
        let active_binding_id = self
            .0
            .lock()
            .map_err(|_| "Solo lock poisoned")?
            .as_ref()
            .map(|a| a.binding.id.clone());
        Ok(SoloContext {
            active_binding_id,
            targets,
            wave_link_channel_ids,
        })
    }

    pub(crate) fn reconcile(&self, state: &AppState) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(active) = guard.as_mut() {
                if active.restoring {
                    return;
                }
                if let Err(error) = apply_sources(state.audio.as_ref(), active) {
                    crate::run_logger::warn("solo", "isolation_refresh_failed", &error);
                }
            }
        }
    }

    pub(crate) fn take_restore(
        &self,
        state: &AppState,
    ) -> Result<Option<WaveLinkSoloPlan>, String> {
        let mut guard = self.0.lock().map_err(|_| "Solo lock poisoned")?;
        let Some(active) = guard.as_mut() else {
            return Ok(None);
        };
        // Keep the snapshot available for retry if a live session refuses a write.
        active.restoring = true;
        restore_sources(state.audio.as_ref(), active)?;
        let active = guard.take().expect("restored Solo");
        send_lights(state, &active.binding, false);
        Ok(active.wave_link)
    }

    fn start(
        &self,
        state: &AppState,
        binding_id: &str,
        wave_link: Option<WaveLinkSoloPlan>,
    ) -> Result<(), String> {
        let binding = binding(state, binding_id)?;
        let targets = binding.normalized_targets();
        if targets.iter().any(|t| !match t {
            BindingTarget::Application { .. }
            | BindingTarget::Session { .. }
            | BindingTarget::Device { .. }
            | BindingTarget::Master
            | BindingTarget::Focus
            | BindingTarget::Unset => true,
            BindingTarget::Integration { integration_id, .. } => integration_id == "wavelink",
            _ => false,
        }) {
            return Err("Solo requires a Windows audio or Wave Link target".into());
        }
        let (focused_id, devices) = selection_context(state.audio.as_ref())?;
        let default_device_id = devices.iter().find(|d| d.is_default).map(|d| d.id.clone());
        let sources = state.audio.list_solo_sources().map_err(|e| e.to_string())?;
        let has_native = sources.iter().any(|s| {
            selected(
                s,
                &targets,
                focused_id.as_deref(),
                default_device_id.as_deref(),
            )
        });
        let has_wave = targets.iter().any(|t| matches!(t, BindingTarget::Integration { integration_id, .. } if integration_id == "wavelink"));
        if !has_native && !has_wave {
            return Err("The selected source is unavailable".into());
        }
        if has_wave && wave_link.is_none() {
            return Err("Wave Link must be connected to use Solo".into());
        }
        let mut active = ActiveSolo {
            restoring: false,
            binding,
            targets,
            focused_id,
            default_device_id,
            originals: HashMap::new(),
            wave_link,
        };
        if let Err(error) = apply_sources(state.audio.as_ref(), &mut active) {
            if restore_sources(state.audio.as_ref(), &active).is_err() {
                active.restoring = true;
                *self.0.lock().map_err(|_| "Solo lock poisoned")? = Some(active);
            }
            return Err(error);
        }
        send_lights(state, &active.binding, true);
        *self.0.lock().map_err(|_| "Solo lock poisoned")? = Some(active);
        Ok(())
    }
}

fn send_lights(state: &AppState, binding: &Binding, active: bool) {
    for (_, control, _) in binding
        .modifier_controls()
        .filter(|(kind, _, _)| *kind == FaderModifierKind::Solo)
    {
        feedback::send_feedback_to_control(
            state,
            &feedback::FeedbackControlKey::from_aux(control),
            feedback::FeedbackSendOptions {
                value: if active { 1.0 } else { 0.0 },
                silent: false,
                force_hardware_feedback: true,
                context: "solo",
            },
        );
    }
}

async fn send_rpcs(app: &AppHandle, plan: &WaveLinkSoloPlan, restore: bool) -> Result<(), String> {
    let hub = app.state::<crate::ws_bridge::WsHub>();
    for (index, rpc) in (if restore { &plan.restore } else { &plan.apply })
        .iter()
        .enumerate()
    {
        if !["setChannel", "setMix"].contains(&rpc.method.as_str()) {
            return Err("Invalid Solo mixer operation".into());
        }
        hub.send_cleanup_text(plan.ws_id, rpc_message(rpc, index))
            .await?;
    }
    Ok(())
}

fn rpc_message(rpc: &SoloRpc, index: usize) -> String {
    // Wave Link requires numeric IDs. Negative IDs keep restoration responses
    // separate from the plugin's positive request IDs and pending state reads.
    serde_json::json!({"jsonrpc":"2.0", "id": -10_000 - index as i64, "method": rpc.method, "params": rpc.params}).to_string()
}

pub(crate) async fn reset(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if let Some(plan) = state.solo.take_restore(state)? {
        send_rpcs(app, &plan, true).await?;
    }
    Ok(())
}

pub(crate) fn reset_for_profile(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if let Some(plan) = state.solo.take_restore(state)? {
        tauri::async_runtime::block_on(send_rpcs(app, &plan, true))?;
    }
    let _ = app.emit("binding_solo_reset", ());
    Ok(())
}

pub(crate) async fn set(
    app: &AppHandle,
    state: &AppState,
    binding_id: &str,
    active: bool,
    wave_link: Option<WaveLinkSoloPlan>,
) -> Result<(), String> {
    reset(app, state).await?;
    if !active {
        return Ok(());
    }
    if let Some(plan) = &wave_link {
        if let Err(error) = send_rpcs(app, plan, false).await {
            let _ = send_rpcs(app, plan, true).await;
            return Err(error);
        }
    }
    if let Err(error) = state.solo.start(state, binding_id, wave_link.clone()) {
        if let Some(plan) = &wave_link {
            let _ = send_rpcs(app, plan, true).await;
        }
        return Err(error);
    }
    Ok(())
}
