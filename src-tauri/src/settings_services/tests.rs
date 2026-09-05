use super::{normalize_appearance_settings, normalize_fader_curve_presets};
use crate::{
    app_settings::{AppAppearanceSettings, AppearanceTheme, FaderCurvePreset},
    model::FaderCurvePoint,
};

#[test]
fn appearance_surface_contrast_and_icon_glow_are_clamped() {
    let mut appearance = AppAppearanceSettings {
        surface_contrast: 125.0,
        icon_glow: -20.0,
        ..AppAppearanceSettings::default()
    };
    appearance.custom_themes.push(AppearanceTheme {
        surface_contrast: -10.0,
        icon_glow: 140.0,
        ..AppearanceTheme::default()
    });

    let normalized = normalize_appearance_settings(appearance).expect("normalize appearance");

    assert_eq!(normalized.surface_contrast, 100.0);
    assert_eq!(normalized.icon_glow, 0.0);
    assert_eq!(normalized.custom_themes[0].surface_contrast, 0.0);
    assert_eq!(normalized.custom_themes[0].icon_glow, 100.0);
}

#[test]
fn fader_curve_presets_are_normalized() {
    let presets = normalize_fader_curve_presets(vec![
        FaderCurvePreset {
            id: "Drums Ride".to_string(),
            name: "  Drums   Ride  ".to_string(),
            points: vec![
                FaderCurvePoint {
                    x: 1.2,
                    y: -1.0,
                    curve: 2.0,
                },
                FaderCurvePoint {
                    x: 0.4,
                    y: 0.8,
                    curve: -0.4,
                },
                FaderCurvePoint {
                    x: -0.2,
                    y: 2.0,
                    curve: 0.25,
                },
            ],
        },
        FaderCurvePreset {
            id: "Drums Ride".to_string(),
            name: "Drums Ride".to_string(),
            points: vec![
                FaderCurvePoint {
                    x: 0.0,
                    y: 0.0,
                    curve: 0.0,
                },
                FaderCurvePoint {
                    x: 1.0,
                    y: 1.0,
                    curve: 0.0,
                },
            ],
        },
        FaderCurvePreset {
            id: "ignored".to_string(),
            name: "   ".to_string(),
            points: vec![
                FaderCurvePoint {
                    x: 0.0,
                    y: 0.0,
                    curve: 0.0,
                },
                FaderCurvePoint {
                    x: 1.0,
                    y: 1.0,
                    curve: 0.0,
                },
            ],
        },
    ]);

    assert_eq!(presets.len(), 2);
    assert_eq!(presets[0].id, "drums-ride");
    assert_eq!(presets[0].name, "Drums Ride");
    assert_eq!(presets[0].points[0].x, 0.0);
    assert_eq!(presets[0].points[0].y, 1.0);
    assert_eq!(presets[0].points[0].curve, 0.25);
    assert_eq!(presets[0].points[1].curve, -0.4);
    assert_eq!(presets[0].points[2].x, 1.0);
    assert_eq!(presets[0].points[2].y, 0.0);
    assert_eq!(presets[0].points[2].curve, 0.0);
    assert_eq!(presets[1].id, "drums-ride-2");
    assert_eq!(presets[1].name, "Drums Ride 2");
}

#[test]
fn fader_curve_presets_are_capped() {
    let presets = normalize_fader_curve_presets(
        (0..55)
            .map(|index| FaderCurvePreset {
                id: format!("curve-{index}"),
                name: format!("Curve {index}"),
                points: vec![
                    FaderCurvePoint {
                        x: 0.0,
                        y: 0.0,
                        curve: 0.0,
                    },
                    FaderCurvePoint {
                        x: 1.0,
                        y: 1.0,
                        curve: 0.0,
                    },
                ],
            })
            .collect(),
    );

    assert_eq!(presets.len(), 50);
}
