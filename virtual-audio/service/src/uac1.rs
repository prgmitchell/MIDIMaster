use std::collections::HashMap;

pub const DESCRIPTOR_DEVICE: u8 = 0x01;
pub const DESCRIPTOR_CONFIGURATION: u8 = 0x02;
pub const DESCRIPTOR_STRING: u8 = 0x03;

#[derive(Debug, Clone)]
pub struct Descriptors {
    pub device: Vec<u8>,
    pub configuration: Vec<u8>,
    pub strings: HashMap<u8, Vec<u8>>,
}

impl Descriptors {
    pub fn new(vid: u16, pid: u16) -> Self {
        let mut device = vec![
            18,
            DESCRIPTOR_DEVICE,
            0x10,
            0x01,
            0,
            0,
            0,
            64,
            0,
            0,
            0,
            0,
            0x01,
            0x00,
            1,
            2,
            3,
            1,
        ];
        device[8..10].copy_from_slice(&vid.to_le_bytes());
        device[10..12].copy_from_slice(&pid.to_le_bytes());

        let mut configuration = Vec::new();
        macro_rules! add {
            ($($value:expr),+ $(,)?) => { configuration.extend_from_slice(&[$($value),+]) };
        }
        // Configuration and AudioControl interface. Only the capture path is
        // exposed to Windows; MIDIMaster feeds PCM through a private pipe.
        add!(9, 0x02, 0, 0, 2, 1, 0, 0x80, 50);
        add!(9, 0x04, 0, 0, 0, 0x01, 0x01, 0x00, 0);
        add!(9, 0x24, 0x01, 0x00, 0x01, 40, 0, 1, 1);
        // Microphone terminal -> feature unit -> USB capture terminal.
        add!(12, 0x24, 0x02, 4, 0x01, 0x02, 0, 2, 0x03, 0, 0, 0);
        add!(10, 0x24, 0x06, 5, 4, 1, 0x03, 0, 0, 0);
        add!(9, 0x24, 0x03, 6, 0x01, 0x01, 0, 5, 0);
        // Capture streaming interface, alternate zero and active alternate one.
        add!(9, 0x04, 1, 0, 0, 0x01, 0x02, 0, 0);
        add!(9, 0x04, 1, 1, 1, 0x01, 0x02, 0, 0);
        add!(7, 0x24, 0x01, 6, 1, 0x01, 0);
        add!(11, 0x24, 0x02, 1, 2, 2, 16, 1, 0x80, 0xBB, 0);
        add!(9, 0x05, 0x82, 0x0D, 0xC0, 0, 1, 0, 0);
        add!(7, 0x25, 0x01, 0, 0, 0, 0);
        let total = u16::try_from(configuration.len()).expect("configuration descriptor length");
        configuration[2..4].copy_from_slice(&total.to_le_bytes());

        let strings = HashMap::from([
            (0, vec![4, DESCRIPTOR_STRING, 0x09, 0x04]),
            (1, string_descriptor("MIDIMaster")),
            (2, string_descriptor("MIDIMaster Virtual Microphone")),
            (3, string_descriptor("MIDIMASTER-VA-001")),
        ]);
        let descriptors = Self {
            device,
            configuration,
            strings,
        };
        descriptors.validate().expect("static UAC1 descriptors");
        descriptors
    }

    pub fn get(&self, descriptor_type: u8, index: u8) -> Option<Vec<u8>> {
        match (descriptor_type, index) {
            (DESCRIPTOR_DEVICE, 0) => Some(self.device.clone()),
            (DESCRIPTOR_CONFIGURATION, 0) => Some(self.configuration.clone()),
            (DESCRIPTOR_STRING, index) => self.strings.get(&index).cloned(),
            _ => None,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.device.len() != 18 || self.device[..2] != [18, DESCRIPTOR_DEVICE] {
            return Err("invalid device descriptor".into());
        }
        if self.configuration.len() < 9 || self.configuration[1] != DESCRIPTOR_CONFIGURATION {
            return Err("invalid configuration descriptor".into());
        }
        let declared = u16::from_le_bytes([self.configuration[2], self.configuration[3]]) as usize;
        if declared != self.configuration.len() {
            return Err(format!(
                "configuration length {declared} does not match {}",
                self.configuration.len()
            ));
        }
        let mut offset = 0;
        while offset < self.configuration.len() {
            let length = self.configuration[offset] as usize;
            if length < 2 || offset + length > self.configuration.len() {
                return Err(format!("invalid descriptor at offset {offset}"));
            }
            offset += length;
        }
        Ok(())
    }
}

fn string_descriptor(text: &str) -> Vec<u8> {
    let units: Vec<u16> = text.encode_utf16().take(126).collect();
    let mut bytes = Vec::with_capacity(2 + units.len() * 2);
    bytes.push((2 + units.len() * 2) as u8);
    bytes.push(DESCRIPTOR_STRING);
    for unit in units {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SetupPacket {
    pub request_type: u8,
    pub request: u8,
    pub value: u16,
    pub index: u16,
    pub length: u16,
}

impl SetupPacket {
    pub fn parse(bytes: [u8; 8]) -> Self {
        Self {
            request_type: bytes[0],
            request: bytes[1],
            value: u16::from_le_bytes([bytes[2], bytes[3]]),
            index: u16::from_le_bytes([bytes[4], bytes[5]]),
            length: u16::from_le_bytes([bytes[6], bytes[7]]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_descriptors_validate_and_expose_identity() {
        let descriptors = Descriptors::new(0x1209, 0x4321);
        assert_eq!(
            u16::from_le_bytes([descriptors.device[8], descriptors.device[9]]),
            0x1209
        );
        assert_eq!(
            u16::from_le_bytes([descriptors.device[10], descriptors.device[11]]),
            0x4321
        );
        assert_eq!(descriptors.configuration.len(), 110);
        assert_eq!(descriptors.configuration[4], 2);
        let mut endpoints = Vec::new();
        let mut offset = 0usize;
        while offset < descriptors.configuration.len() {
            let length = descriptors.configuration[offset] as usize;
            if descriptors.configuration[offset + 1] == 0x05 {
                endpoints.push(descriptors.configuration[offset + 2]);
            }
            offset += length;
        }
        assert_eq!(endpoints, [0x82]);
        descriptors.validate().unwrap();
    }
}
