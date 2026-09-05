//! Fixtures shared with the JavaScript compatibility suite.
use crate::{fader_curve, model};

#[derive(serde::Deserialize)]
struct CurveCase {
    name: String,
    curve: model::FaderCurve,
    input: f32,
    points: Vec<model::FaderCurvePoint>,
    expected: f32,
}

#[test]
fn frontend_and_runtime_curves_share_compatibility_cases() {
    let cases: Vec<CurveCase> =
        serde_json::from_str(include_str!("../../scripts/fixtures/fader-curves.json")).unwrap();
    for case in cases {
        let binding = model::Binding {
            fader_curve: case.curve,
            custom_curve: case.points,
            ..crate::test_support::binding()
        };
        let actual = fader_curve::apply_fader_curve(&binding, case.input);
        assert!(
            (actual - case.expected).abs() < 0.00001,
            "{}: {} != {}",
            case.name,
            actual,
            case.expected
        );
        let feedback = fader_curve::invert_fader_curve(&binding, case.expected);
        assert!(
            (feedback - case.input.clamp(0.0, 1.0)).abs() < 0.0001,
            "{} motor feedback",
            case.name
        );
    }
}

#[test]
fn current_and_legacy_profiles_round_trip_without_losing_plugin_settings() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../scripts/fixtures/profiles.json")).unwrap();
    for fixture in fixtures {
        let mut profile: model::Profile = serde_json::from_value(fixture.clone()).unwrap();
        profile.normalize_bindings();
        profile.normalize_for_storage();
        let saved = serde_json::to_value(&profile).unwrap();
        let mut restored: model::Profile = serde_json::from_value(saved.clone()).unwrap();
        restored.restore_from_storage();
        restored.normalize_for_storage();
        assert_eq!(serde_json::to_value(&restored).unwrap(), saved);
        assert_eq!(
            saved["plugin_settings"]["obs"],
            fixture["plugin_settings"]["obs"]
        );
        assert_eq!(restored.bindings.len(), 1);
        restored.restore_from_storage();
        assert_eq!(
            restored.bindings[0].normalized_targets_ref().first(),
            Some(&model::BindingTarget::Master)
        );
        if fixture["name"] == "Current profile" {
            assert_eq!(restored.bindings[0].assign_mode, model::AssignMode::Clear);
            assert!(!restored.bindings[0].feedback_enabled);
        }
    }
}
