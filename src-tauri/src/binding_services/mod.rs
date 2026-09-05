use crate::binding_actions;
use crate::feedback::{self, FeedbackControlKey, FeedbackSendOptions};
use crate::run_logger;
use crate::{bindings::BindingKey, model, model::Binding, AppState};
use futures_util::future::join_all;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

mod execution;
mod feedback_outputs;
mod feedback_updates;
mod macro_runner;
mod mutations;
pub(crate) use execution::apply_binding_action;
use feedback_outputs::*;
pub(crate) use feedback_updates::{
    set_binding_feedback, set_integration_connection_state, update_midi_feedback,
};
pub(crate) use macro_runner::spawn_macro_binding;
use macro_runner::{action_can_run_from_command, run_macro_binding};
#[cfg(test)]
pub(crate) use mutations::add_binding_to_active_profile;
pub(crate) use mutations::{add_binding, remove_binding};
#[cfg(test)]
mod tests;
