use std::sync::Mutex;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RingStats {
    pub available: usize,
    pub dropped_bytes: u64,
    pub underrun_bytes: u64,
}

#[derive(Debug)]
struct Inner {
    bytes: Vec<u8>,
    read: usize,
    write: usize,
    size: usize,
    dropped: u64,
    underruns: u64,
}

#[derive(Debug)]
pub struct AudioRing {
    inner: Mutex<Inner>,
}

impl AudioRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                bytes: vec![0; capacity.max(1)],
                read: 0,
                write: 0,
                size: 0,
                dropped: 0,
                underruns: 0,
            }),
        }
    }

    pub fn write_latest(&self, input: &[u8]) {
        let mut ring = self.inner.lock().expect("audio ring poisoned");
        for &byte in input {
            if ring.size == ring.bytes.len() {
                ring.read = (ring.read + 1) % ring.bytes.len();
                ring.size -= 1;
                ring.dropped += 1;
            }
            let write = ring.write;
            ring.bytes[write] = byte;
            ring.write = (write + 1) % ring.bytes.len();
            ring.size += 1;
        }
    }

    pub fn read_or_silence(&self, output: &mut [u8]) -> usize {
        let mut ring = self.inner.lock().expect("audio ring poisoned");
        let mut read = 0usize;
        for byte in output.iter_mut() {
            if ring.size == 0 {
                *byte = 0;
            } else {
                *byte = ring.bytes[ring.read];
                ring.read = (ring.read + 1) % ring.bytes.len();
                ring.size -= 1;
                read += 1;
            }
        }
        ring.underruns += (output.len() - read) as u64;
        read
    }

    pub fn reset(&self) {
        let mut ring = self.inner.lock().expect("audio ring poisoned");
        ring.read = 0;
        ring.write = 0;
        ring.size = 0;
    }

    pub fn stats(&self) -> RingStats {
        let ring = self.inner.lock().expect("audio ring poisoned");
        RingStats {
            available: ring.size,
            dropped_bytes: ring.dropped,
            underrun_bytes: ring.underruns,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_newest_data_when_full() {
        let ring = AudioRing::new(4);
        ring.write_latest(&[1, 2, 3, 4, 5, 6]);
        let mut out = [0; 4];
        assert_eq!(ring.read_or_silence(&mut out), 4);
        assert_eq!(out, [3, 4, 5, 6]);
        assert_eq!(ring.stats().dropped_bytes, 2);
    }

    #[test]
    fn fills_underruns_with_digital_silence() {
        let ring = AudioRing::new(4);
        ring.write_latest(&[7, 8]);
        let mut out = [99; 4];
        assert_eq!(ring.read_or_silence(&mut out), 2);
        assert_eq!(out, [7, 8, 0, 0]);
        assert_eq!(ring.stats().underrun_bytes, 2);
    }
}
