use super::*;

fn mapping(controller: u8) -> AuxiliaryControl {
    serde_json::from_value(serde_json::json!({
        "device_id": "midi", "channel": 0, "controller": controller,
        "msg_type": "Note", "mute_behavior": "SetFromValue"
    }))
    .unwrap()
}

#[test]
fn modifier_list_round_trips_every_mapping_and_its_behavior() {
    let mut binding = crate::test_support::binding();
    binding.mute_control = Some(mapping(30));
    binding.assign_control = Some(mapping(31));
    binding.modifiers = Some(vec![
        FaderModifier {
            id: "mute-1".into(),
            kind: FaderModifierKind::Mute,
            control: Some(mapping(16)),
            assign_mode: AssignMode::Add,
        },
        FaderModifier {
            id: "mute-2".into(),
            kind: FaderModifierKind::Solo,
            control: Some(mapping(17)),
            assign_mode: AssignMode::Add,
        },
        FaderModifier {
            id: "assign-1".into(),
            kind: FaderModifierKind::Assign,
            control: Some(mapping(18)),
            assign_mode: AssignMode::Replace,
        },
        FaderModifier {
            id: "draft".into(),
            kind: FaderModifierKind::Assign,
            control: None,
            assign_mode: AssignMode::Clear,
        },
    ]);
    let restored: Binding =
        serde_json::from_value(serde_json::to_value(&binding).unwrap()).unwrap();
    let controls: Vec<_> = restored.modifier_controls().collect();
    assert_eq!(controls.len(), 3);
    assert_eq!(
        controls
            .iter()
            .map(|(_, control, _)| control.controller)
            .collect::<Vec<_>>(),
        vec![16, 17, 18]
    );
    assert_eq!(controls[1].1.mute_behavior, MuteBehavior::SetFromValue);
    assert_eq!(controls[1].0, FaderModifierKind::Solo);
    assert_eq!(*controls[2].2, AssignMode::Replace);
}

#[test]
fn legacy_controls_work_until_an_explicit_list_replaces_them() {
    let mut binding = crate::test_support::binding();
    binding.mute_control = Some(mapping(16));
    binding.assign_control = Some(mapping(17));
    binding.assign_mode = AssignMode::Clear;
    let controls: Vec<_> = binding.modifier_controls().collect();
    assert_eq!(controls.len(), 2);
    assert_eq!(controls[0].0, FaderModifierKind::Mute);
    assert_eq!(*controls[1].2, AssignMode::Clear);
    binding.modifiers = Some(vec![]);
    let restored: Binding =
        serde_json::from_value(serde_json::to_value(&binding).unwrap()).unwrap();
    assert_eq!(
        restored.modifier_controls().count(),
        0,
        "removed controls stay removed after reload"
    );
}
