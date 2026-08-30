use crate::model::{Binding, FaderCurve, FaderCurvePoint};

const MIN_CUSTOM_POINTS: usize = 2;
const INVERSE_SEARCH_STEPS: usize = 24;
const COEFFICIENT_EPSILON: f32 = 1.0e-7;
const CANDIDATE_TIE_EPSILON: f32 = 1.0e-6;

pub(crate) fn apply_fader_curve(binding: &Binding, normalized: f32) -> f32 {
    apply_curve(&binding.fader_curve, &binding.custom_curve, normalized)
}

pub(crate) fn invert_fader_curve(binding: &Binding, normalized: f32) -> f32 {
    invert_curve(&binding.fader_curve, &binding.custom_curve, normalized)
}

fn apply_curve(curve: &FaderCurve, custom_points: &[FaderCurvePoint], normalized: f32) -> f32 {
    let clamped = normalized.clamp(0.0, 1.0);
    match curve {
        FaderCurve::Linear => clamped,
        FaderCurve::Exponential => clamped.powf(0.55),
        // Audio taper-style response for finer low-end control.
        FaderCurve::Logarithmic => clamped.powf(2.2),
        FaderCurve::SCurve => {
            let x = clamped;
            (x * x * (3.0 - (2.0 * x))).clamp(0.0, 1.0)
        }
        FaderCurve::Custom => interpolate_custom_curve(custom_points, clamped),
    }
}

fn invert_curve(curve: &FaderCurve, custom_points: &[FaderCurvePoint], normalized: f32) -> f32 {
    let target = normalized.clamp(0.0, 1.0);
    match curve {
        FaderCurve::Linear => target,
        FaderCurve::Exponential => target.powf(1.0 / 0.55),
        FaderCurve::Logarithmic => target.powf(1.0 / 2.2),
        FaderCurve::SCurve => invert_s_curve(target),
        FaderCurve::Custom => invert_custom_curve(custom_points, target),
    }
}

fn invert_s_curve(target: f32) -> f32 {
    if target <= 0.0 {
        return 0.0;
    }
    if target >= 1.0 {
        return 1.0;
    }

    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..INVERSE_SEARCH_STEPS {
        let middle = (low + high) * 0.5;
        let value = middle * middle * (3.0 - (2.0 * middle));
        if value < target {
            low = middle;
        } else {
            high = middle;
        }
    }
    (low + high) * 0.5
}

fn sorted_custom_points(points: &[FaderCurvePoint]) -> Vec<FaderCurvePoint> {
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    sorted
}

fn interpolate_custom_curve(points: &[FaderCurvePoint], normalized: f32) -> f32 {
    if points.len() < MIN_CUSTOM_POINTS {
        return normalized;
    }

    let sorted = sorted_custom_points(points);
    interpolate_sorted_custom_curve(&sorted, normalized)
}

fn interpolate_sorted_custom_curve(points: &[FaderCurvePoint], normalized: f32) -> f32 {
    let input = normalized.clamp(0.0, 1.0);
    if input <= points[0].x {
        return points[0].y.clamp(0.0, 1.0);
    }

    for pair in points.windows(2) {
        let start = &pair[0];
        let end = &pair[1];
        if input > end.x {
            continue;
        }

        let x0 = start.x.clamp(0.0, 1.0);
        let x1 = end.x.clamp(0.0, 1.0);
        let y0 = start.y.clamp(0.0, 1.0);
        let y1 = end.y.clamp(0.0, 1.0);
        let span = (x1 - x0).abs();
        if span < f32::EPSILON {
            return y1;
        }
        let t = ((input - x0) / (x1 - x0)).clamp(0.0, 1.0);
        let linear = y0 + ((y1 - y0) * t);
        let curve_offset = start.curve.clamp(-1.0, 1.0) * 2.0 * (1.0 - t) * t;
        return (linear + curve_offset).clamp(0.0, 1.0);
    }

    points
        .last()
        .map(|point| point.y.clamp(0.0, 1.0))
        .unwrap_or(input)
}

fn invert_custom_curve(points: &[FaderCurvePoint], target: f32) -> f32 {
    if points.len() < MIN_CUSTOM_POINTS {
        return target;
    }

    let sorted = sorted_custom_points(points);
    let mut candidates = vec![0.0, 1.0];

    for pair in sorted.windows(2) {
        let start = &pair[0];
        let end = &pair[1];
        let x0 = start.x.clamp(0.0, 1.0);
        let x1 = end.x.clamp(0.0, 1.0);
        let span = x1 - x0;
        if span.abs() < f32::EPSILON {
            candidates.push(x1);
            continue;
        }

        let y0 = start.y.clamp(0.0, 1.0);
        let y1 = end.y.clamp(0.0, 1.0);
        let curve = start.curve.clamp(-1.0, 1.0);
        let quadratic = -2.0 * curve;
        let linear = (y1 - y0) + (2.0 * curve);
        let constant = y0 - target;

        candidates.push(x0);
        candidates.push(x1);

        if quadratic.abs() < COEFFICIENT_EPSILON {
            if linear.abs() >= COEFFICIENT_EPSILON {
                push_segment_candidate(&mut candidates, x0, span, -constant / linear);
            }
            continue;
        }

        push_segment_candidate(&mut candidates, x0, span, -linear / (2.0 * quadratic));

        let discriminant = (linear * linear) - (4.0 * quadratic * constant);
        if discriminant >= -COEFFICIENT_EPSILON {
            let root = discriminant.max(0.0).sqrt();
            push_segment_candidate(
                &mut candidates,
                x0,
                span,
                (-linear - root) / (2.0 * quadratic),
            );
            push_segment_candidate(
                &mut candidates,
                x0,
                span,
                (-linear + root) / (2.0 * quadratic),
            );
        }
    }

    let mut best_position = 0.0;
    let mut best_error = f32::INFINITY;
    for position in candidates {
        let position = position.clamp(0.0, 1.0);
        let error = (interpolate_sorted_custom_curve(&sorted, position) - target).abs();
        if error + CANDIDATE_TIE_EPSILON < best_error
            || ((error - best_error).abs() <= CANDIDATE_TIE_EPSILON && position < best_position)
        {
            best_position = position;
            best_error = error;
        }
    }
    best_position
}

fn push_segment_candidate(candidates: &mut Vec<f32>, x0: f32, span: f32, t: f32) {
    if (-COEFFICIENT_EPSILON..=1.0 + COEFFICIENT_EPSILON).contains(&t) {
        candidates.push(x0 + (span * t.clamp(0.0, 1.0)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(x: f32, y: f32, curve: f32) -> FaderCurvePoint {
        FaderCurvePoint { x, y, curve }
    }

    #[test]
    fn built_in_curves_round_trip_representative_values() {
        let curves = [
            FaderCurve::Linear,
            FaderCurve::Exponential,
            FaderCurve::Logarithmic,
            FaderCurve::SCurve,
        ];

        for curve in curves {
            for physical in [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
                let logical = apply_curve(&curve, &[], physical);
                let restored = invert_curve(&curve, &[], logical);
                assert!(
                    (restored - physical).abs() < 1.0e-5,
                    "curve={curve:?} physical={physical} logical={logical} restored={restored}"
                );
            }
        }
    }

    #[test]
    fn custom_curve_feedback_restores_the_reported_physical_position() {
        let points = [
            point(0.0, 0.0, 0.0),
            point(0.5, 0.75, 0.0),
            point(1.0, 1.0, 0.0),
        ];

        let logical = apply_curve(&FaderCurve::Custom, &points, 0.5);
        let restored = invert_curve(&FaderCurve::Custom, &points, logical);

        assert!((logical - 0.75).abs() < f32::EPSILON);
        assert!((restored - 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn curved_custom_segments_round_trip() {
        let points = [point(0.0, 0.0, 0.5), point(1.0, 1.0, 0.0)];

        for physical in [0.0, 0.2, 0.5, 0.8, 1.0] {
            let logical = apply_curve(&FaderCurve::Custom, &points, physical);
            let restored = invert_curve(&FaderCurve::Custom, &points, logical);
            assert!((restored - physical).abs() < 1.0e-5);
        }
    }

    #[test]
    fn non_monotonic_custom_curve_uses_the_lowest_matching_position() {
        let points = [
            point(0.0, 0.0, 0.0),
            point(0.5, 1.0, 0.0),
            point(1.0, 0.0, 0.0),
        ];

        let restored = invert_curve(&FaderCurve::Custom, &points, 0.5);

        assert!((restored - 0.25).abs() < 1.0e-6);
    }

    #[test]
    fn unreachable_custom_values_choose_the_closest_endpoint() {
        let points = [point(0.0, 0.25, 0.0), point(1.0, 0.75, 0.0)];

        assert_eq!(invert_curve(&FaderCurve::Custom, &points, 0.0), 0.0);
        assert_eq!(invert_curve(&FaderCurve::Custom, &points, 1.0), 1.0);
    }

    #[test]
    fn malformed_custom_curve_falls_back_to_linear() {
        let points = [point(0.5, 0.75, 0.0)];

        assert_eq!(apply_curve(&FaderCurve::Custom, &points, 0.3), 0.3);
        assert_eq!(invert_curve(&FaderCurve::Custom, &points, 0.3), 0.3);
    }
}
