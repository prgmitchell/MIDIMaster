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
        let capacity = ring.bytes.len();
        if input.len() >= capacity {
            ring.dropped += (ring.size + input.len() - capacity) as u64;
            ring.bytes.copy_from_slice(&input[input.len() - capacity..]);
            ring.read = 0;
            ring.write = 0;
            ring.size = capacity;
            return;
        }
        let dropped = input.len().saturating_sub(capacity - ring.size);
        ring.read = (ring.read + dropped) % capacity;
        ring.dropped += dropped as u64;
        let write = ring.write;
        let first = input.len().min(capacity - write);
        ring.bytes[write..write + first].copy_from_slice(&input[..first]);
        ring.bytes[..input.len() - first].copy_from_slice(&input[first..]);
        ring.write = (write + input.len()) % capacity;
        ring.size = ring.size + input.len() - dropped;
    }

    pub fn read_or_silence(&self, output: &mut [u8]) -> usize {
        let mut ring = self.inner.lock().expect("audio ring poisoned");
        let read = output.len().min(ring.size);
        let first = read.min(ring.bytes.len() - ring.read);
        output[..first].copy_from_slice(&ring.bytes[ring.read..ring.read + first]);
        output[first..read].copy_from_slice(&ring.bytes[..read - first]);
        output[read..].fill(0);
        ring.read = (ring.read + read) % ring.bytes.len();
        ring.size -= read;
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
