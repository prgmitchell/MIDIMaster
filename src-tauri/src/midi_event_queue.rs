use crate::model::{MidiEvent, MidiMessageType};
use crate::run_logger;
use std::collections::{HashMap, VecDeque};

const DEFAULT_MAX_PENDING_KEYS: usize = 256;
const DEFAULT_MAX_PRESERVED_EVENTS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MidiEventKey {
    device_id: String,
    channel: u8,
    controller: u8,
    msg_type: MidiMessageType,
}

impl From<&MidiEvent> for MidiEventKey {
    fn from(event: &MidiEvent) -> Self {
        Self {
            device_id: event.device_id.clone(),
            channel: event.channel,
            controller: event.controller,
            msg_type: event.msg_type.clone(),
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MidiEventQueueStats {
    pub(crate) coalesced: u64,
    pub(crate) dropped: u64,
}

#[derive(Debug)]
struct QueuedMidiEvent {
    sequence: u64,
    event: MidiEvent,
}

pub(crate) struct MidiEventQueue {
    pending_latest: HashMap<MidiEventKey, QueuedMidiEvent>,
    preserved: VecDeque<QueuedMidiEvent>,
    max_pending_keys: usize,
    max_preserved_events: usize,
    next_sequence: u64,
    coalesced_since_log: u64,
    dropped_since_log: u64,
}

impl Default for MidiEventQueue {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_PENDING_KEYS, DEFAULT_MAX_PRESERVED_EVENTS)
    }
}

impl MidiEventQueue {
    pub(crate) fn new(max_pending_keys: usize, max_preserved_events: usize) -> Self {
        Self {
            pending_latest: HashMap::new(),
            preserved: VecDeque::new(),
            max_pending_keys,
            max_preserved_events,
            next_sequence: 0,
            coalesced_since_log: 0,
            dropped_since_log: 0,
        }
    }

    fn queued_event(&mut self, event: MidiEvent) -> QueuedMidiEvent {
        let queued = QueuedMidiEvent {
            sequence: self.next_sequence,
            event,
        };
        self.next_sequence = self.next_sequence.saturating_add(1);
        queued
    }

    pub(crate) fn enqueue(&mut self, event: MidiEvent) {
        if should_preserve_event(&event) {
            if self.preserved.len() >= self.max_preserved_events {
                self.dropped_since_log += 1;
                return;
            }
            let queued = self.queued_event(event);
            self.preserved.push_back(queued);
            return;
        }

        let key = MidiEventKey::from(&event);
        if self.pending_latest.contains_key(&key) {
            self.coalesced_since_log += 1;
            let queued = self.queued_event(event);
            self.pending_latest.insert(key, queued);
            return;
        }
        if self.pending_latest.len() >= self.max_pending_keys {
            self.dropped_since_log += 1;
            return;
        }
        let queued = self.queued_event(event);
        self.pending_latest.insert(key, queued);
    }

    pub(crate) fn drain(&mut self) -> Vec<MidiEvent> {
        let mut events = Vec::with_capacity(self.preserved.len() + self.pending_latest.len());
        events.extend(self.preserved.drain(..));
        events.extend(self.pending_latest.drain().map(|(_, event)| event));
        events.sort_by_key(|event| event.sequence);
        events.into_iter().map(|event| event.event).collect()
    }

    pub(crate) fn take_stats(&mut self) -> MidiEventQueueStats {
        let stats = MidiEventQueueStats {
            coalesced: self.coalesced_since_log,
            dropped: self.dropped_since_log,
        };
        self.coalesced_since_log = 0;
        self.dropped_since_log = 0;
        stats
    }
}

fn should_preserve_event(event: &MidiEvent) -> bool {
    match event.msg_type {
        MidiMessageType::Note => true,
        MidiMessageType::ControlChange => event.value == 0 || event.value == 127,
        MidiMessageType::PitchBend => false,
    }
}

pub(crate) fn log_queue_stats(stats: MidiEventQueueStats) {
    if stats.coalesced > 0 {
        run_logger::debug(
            "midi_queue",
            "events_coalesced",
            &format!("count={}", stats.coalesced),
        );
    }
    if stats.dropped > 0 {
        run_logger::warn(
            "midi_queue",
            "events_dropped",
            &format!("count={}", stats.dropped),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cc(controller: u8, value: u8) -> MidiEvent {
        MidiEvent {
            device_id: "midi:0".to_string(),
            channel: 0,
            controller,
            value,
            value_14: None,
            msg_type: MidiMessageType::ControlChange,
        }
    }

    fn note(value: u8) -> MidiEvent {
        MidiEvent {
            device_id: "midi:0".to_string(),
            channel: 0,
            controller: 40,
            value,
            value_14: None,
            msg_type: MidiMessageType::Note,
        }
    }

    fn drained_values(queue: &mut MidiEventQueue) -> Vec<u8> {
        queue.drain().into_iter().map(|event| event.value).collect()
    }

    #[test]
    fn continuous_events_collapse_to_latest_value() {
        let mut queue = MidiEventQueue::new(16, 16);
        queue.enqueue(cc(10, 12));
        queue.enqueue(cc(10, 42));
        queue.enqueue(cc(10, 64));

        let drained = queue.drain();

        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].value, 64);
        assert_eq!(queue.take_stats().coalesced, 2);
    }

    #[test]
    fn endpoint_after_adjacent_value_stays_last() {
        let mut queue = MidiEventQueue::new(16, 16);
        queue.enqueue(cc(10, 126));
        queue.enqueue(cc(10, 127));

        assert_eq!(drained_values(&mut queue), vec![126, 127]);
    }

    #[test]
    fn zero_after_adjacent_value_stays_last() {
        let mut queue = MidiEventQueue::new(16, 16);
        queue.enqueue(cc(10, 3));
        queue.enqueue(cc(10, 0));

        assert_eq!(drained_values(&mut queue), vec![3, 0]);
    }

    #[test]
    fn adjacent_value_after_endpoint_stays_last() {
        let mut queue = MidiEventQueue::new(16, 16);
        queue.enqueue(cc(10, 127));
        queue.enqueue(cc(10, 126));

        assert_eq!(drained_values(&mut queue), vec![127, 126]);
    }

    #[test]
    fn button_like_events_are_preserved_in_order() {
        let mut queue = MidiEventQueue::new(16, 16);
        queue.enqueue(note(127));
        queue.enqueue(note(0));
        queue.enqueue(cc(41, 127));
        queue.enqueue(cc(41, 0));

        assert_eq!(drained_values(&mut queue), vec![127, 0, 127, 0]);
        assert_eq!(queue.take_stats().coalesced, 0);
    }

    #[test]
    fn queue_overflow_drops_predictably() {
        let mut queue = MidiEventQueue::new(1, 1);
        queue.enqueue(cc(10, 10));
        queue.enqueue(cc(11, 11));
        queue.enqueue(note(127));
        queue.enqueue(note(0));

        let drained = queue.drain();
        let stats = queue.take_stats();

        assert_eq!(drained.len(), 2);
        assert_eq!(stats.dropped, 2);
    }
}
