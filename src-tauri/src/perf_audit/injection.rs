use crate::model::{MidiEvent, MidiMessageType};

/// Each control completes a press/release cycle independently. With an even
/// control count, alternating on the global sequence would leave half held.
pub(super) fn injected_event(sequence: u64, control_count: u8, kind: &str) -> MidiEvent {
    let control_index = (sequence % u64::from(control_count)) as u8;
    let control_sequence = sequence / u64::from(control_count);
    let (msg_type, value, value_14) = match kind {
        "button" => (
            MidiMessageType::Note,
            if control_sequence.is_multiple_of(2) {
                127
            } else {
                0
            },
            None,
        ),
        "action" => (MidiMessageType::ProgramChange, 127, None),
        "pitch_bend" => {
            let value = (control_sequence % 16_384) as u16;
            (MidiMessageType::PitchBend, (value >> 7) as u8, Some(value))
        }
        _ => (
            MidiMessageType::ControlChange,
            (control_sequence % 126 + 1) as u8,
            None,
        ),
    };
    let controller = match kind {
        "button" => control_index * 8 + 4,
        "action" => control_index * 8,
        "pitch_bend" => 0xe0,
        _ => control_index * 8 + 1,
    };
    MidiEvent {
        device_id: "perf-midi-input".to_string(),
        channel: if kind == "pitch_bend" {
            control_index
        } else {
            controller % 16
        },
        controller,
        value,
        value_14,
        msg_type,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sixteen_controls_each_receive_ordered_press_release_cycles() {
        for control in 0..16 {
            let events: Vec<_> = (0..64)
                .map(|sequence| injected_event(sequence, 16, "button"))
                .filter(|event| event.controller == control * 8 + 4)
                .collect();
            assert_eq!(
                events.iter().map(|event| event.value).collect::<Vec<_>>(),
                [127, 0, 127, 0]
            );
            assert!(events
                .iter()
                .all(|event| event.channel == (control * 8 + 4) % 16));
        }
    }

    #[test]
    fn fourteen_bit_generator_retains_changes_with_the_same_seven_bit_value() {
        let first = injected_event(0, 16, "pitch_bend");
        let second = injected_event(16, 16, "pitch_bend");
        assert_eq!(first.value, second.value);
        assert_eq!(first.value_14, Some(0));
        assert_eq!(second.value_14, Some(1));
        assert_eq!(first.controller, 0xe0);
        assert_eq!(injected_event(15, 16, "pitch_bend").channel, 15);
    }
}
