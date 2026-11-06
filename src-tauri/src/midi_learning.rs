use crate::model::{BindingControlKind, LearnedControl, MidiEvent, MidiMessageType};
use crate::runtime_helpers::{classify_learned_control, LearnCandidate};
use std::time::{Duration, Instant};

/// One lock owns every transition, including publication and cancellation.
#[derive(Default)]
enum LearnPhase {
    #[default]
    Idle,
    Listening(Option<LearnCandidate>),
    Ready(LearnedControl),
}

#[derive(Default)]
pub(crate) struct MidiLearning {
    generation: u64,
    phase: LearnPhase,
}

impl MidiLearning {
    pub(crate) fn start(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.phase = LearnPhase::Listening(None);
        self.generation
    }
    pub(crate) fn cancel(&mut self, session_id: Option<u64>) {
        if session_id.is_none_or(|id| id == self.generation) {
            self.phase = LearnPhase::Idle;
        }
    }
    pub(crate) fn is_listening(&self) -> bool {
        matches!(self.phase, LearnPhase::Listening(_))
    }

    pub(crate) fn consume(&mut self, session_id: Option<u64>) -> Option<LearnedControl> {
        if session_id.is_some_and(|id| id != self.generation)
            || !matches!(self.phase, LearnPhase::Ready(_))
        {
            return None;
        }
        match std::mem::take(&mut self.phase) {
            LearnPhase::Ready(control) => Some(control),
            _ => unreachable!("ready state checked while holding the learning lock"),
        }
    }

    fn publish(&mut self, control: LearnedControl) {
        crate::run_logger::info(
            "learn",
            "control_ready",
            &format!(
                "device_id={} channel={} controller={} msg_type={:?} control_kind={:?}",
                control.device_id,
                control.channel,
                control.controller,
                control.msg_type,
                control.control_kind
            ),
        );
        self.phase = LearnPhase::Ready(control);
    }

    pub(crate) fn settle_candidate(&mut self) {
        if let LearnPhase::Listening(Some(candidate)) = &mut self.phase {
            if candidate.last_seen_at.elapsed() > Duration::from_millis(150) {
                let learned = classify_learned_control(candidate);
                self.publish(learned);
            }
        }
    }

    pub(crate) fn receive(&mut self, event: &MidiEvent) -> bool {
        let LearnPhase::Listening(candidate) = &mut self.phase else {
            return false;
        };
        let mut control = LearnedControl {
            device_id: event.device_id.clone(),
            channel: event.channel,
            controller: event.controller,
            msg_type: event.msg_type.clone(),
            control_kind: BindingControlKind::Auto,
        };
        let is_button_message = matches!(
            event.msg_type,
            MidiMessageType::Note | MidiMessageType::ProgramChange
        );
        if !is_button_message
            && (matches!(event.msg_type, MidiMessageType::PitchBend)
                || crate::runtime_helpers::cc_learn_value_is_definitely_continuous(event.value))
        {
            control.control_kind = BindingControlKind::Continuous;
            self.publish(control);
            return true;
        }
        let now = Instant::now();
        match candidate {
            Some(previous)
                if !is_button_message
                    && previous.control.device_id == control.device_id
                    && previous.control.channel == control.channel
                    && previous.control.controller == control.controller
                    && previous.control.msg_type == control.msg_type =>
            {
                previous.last_seen_at = now;
                previous.saw_zero |= event.value == 0;
                previous.saw_max |= event.value == 127;
            }
            _ => {
                *candidate = Some(LearnCandidate {
                    control,
                    last_seen_at: now,
                    saw_zero: event.value == 0,
                    saw_max: event.value == 127,
                })
            }
        }
        true
    }
}
