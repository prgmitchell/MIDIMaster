use std::collections::VecDeque;

const THRESHOLD: f32 = 29_204.0; // -1 dBFS for signed 16-bit PCM.
const LOOKAHEAD_FRAMES: usize = 240; // 5 ms at 48 kHz.
const RELEASE_COEFFICIENT: f32 = 0.999_791_7; // approximately 100 ms.

#[derive(Debug, Clone, Copy, Default)]
pub struct LimiterStats {
    pub gain_reduction_db: f32,
    pub limited_frames: u64,
}

#[derive(Debug)]
pub struct SafetyLimiter {
    delay: VecDeque<[f32; 2]>,
    pending: Vec<u8>,
    gain: f32,
    hold_frames: usize,
    limited_frames: u64,
}

impl Default for SafetyLimiter {
    fn default() -> Self {
        Self {
            delay: VecDeque::with_capacity(LOOKAHEAD_FRAMES + 1),
            pending: Vec::with_capacity(3),
            gain: 1.0,
            hold_frames: 0,
            limited_frames: 0,
        }
    }
}

impl SafetyLimiter {
    pub fn process(&mut self, input: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.pending.len() + input.len());
        bytes.extend_from_slice(&self.pending);
        bytes.extend_from_slice(input);
        let complete = bytes.len() - (bytes.len() % 4);
        self.pending.clear();
        self.pending.extend_from_slice(&bytes[complete..]);

        let mut output = Vec::with_capacity(complete);
        for frame in bytes[..complete].chunks_exact(4) {
            let left = i16::from_le_bytes([frame[0], frame[1]]) as f32;
            let right = i16::from_le_bytes([frame[2], frame[3]]) as f32;
            let peak = left.abs().max(right.abs());
            let target = if peak > THRESHOLD {
                THRESHOLD / peak
            } else {
                1.0
            };
            if target < self.gain {
                self.gain = target;
                self.hold_frames = LOOKAHEAD_FRAMES;
            } else if target < 1.0 {
                // Any above-ceiling future frame extends the hold, even when
                // the current gain is already conservative enough for it.
                self.hold_frames = LOOKAHEAD_FRAMES;
            } else if self.hold_frames > 0 {
                // Keep the gain fixed until the peak that established it has
                // crossed the complete lookahead delay.
                self.hold_frames -= 1;
            } else {
                self.gain = 1.0 - ((1.0 - self.gain) * RELEASE_COEFFICIENT);
            }
            if self.gain < 0.999_99 {
                self.limited_frames += 1;
            }
            self.delay.push_back([left, right]);
            if self.delay.len() > LOOKAHEAD_FRAMES {
                let delayed = self.delay.pop_front().expect("limiter delay");
                for sample in delayed {
                    let limited = (sample * self.gain).round().clamp(-32_768.0, 32_767.0) as i16;
                    output.extend_from_slice(&limited.to_le_bytes());
                }
            }
        }
        output
    }

    pub fn stats(&self) -> LimiterStats {
        LimiterStats {
            gain_reduction_db: if self.gain >= 1.0 {
                0.0
            } else {
                -20.0 * self.gain.log10()
            },
            limited_frames: self.limited_frames,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(value: i16) -> [u8; 4] {
        let b = value.to_le_bytes();
        [b[0], b[1], b[0], b[1]]
    }

    #[test]
    fn lookahead_delays_and_limits_linked_stereo() {
        let mut limiter = SafetyLimiter::default();
        let mut input = Vec::new();
        for _ in 0..LOOKAHEAD_FRAMES {
            input.extend_from_slice(&frame(20_000));
        }
        input.extend_from_slice(&frame(i16::MAX));
        for _ in 0..LOOKAHEAD_FRAMES {
            input.extend_from_slice(&frame(0));
        }
        let output = limiter.process(&input);
        assert_eq!(output.len(), (LOOKAHEAD_FRAMES + 1) * 4);
        let first = i16::from_le_bytes([output[0], output[1]]).unsigned_abs();
        assert!(first <= 17_900, "lookahead gain was not applied: {first}");
        let peak_offset = LOOKAHEAD_FRAMES * 4;
        let delayed_peak =
            i16::from_le_bytes([output[peak_offset], output[peak_offset + 1]]).unsigned_abs();
        assert!(
            delayed_peak <= THRESHOLD as u16,
            "delayed peak exceeded -1 dBFS: {delayed_peak}"
        );
        assert!(limiter.stats().gain_reduction_db > 0.9);
    }

    #[test]
    fn retains_partial_pcm_frame_between_packets() {
        let mut limiter = SafetyLimiter::default();
        assert!(limiter.process(&[1, 2, 3]).is_empty());
        assert!(limiter.process(&[4]).is_empty());
        assert_eq!(limiter.pending.len(), 0);
        assert_eq!(limiter.delay.len(), 1);
    }
}
