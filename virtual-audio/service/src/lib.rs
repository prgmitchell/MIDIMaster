// Portions of this user-space USB/IP/UAC1 implementation are derived from
// Virtual Cables. See ../../THIRD_PARTY_NOTICES.txt for the BSD 2-Clause notice.

pub mod attach;
pub mod audio_pipe;
pub mod device;
pub mod limiter;
pub mod ring;
pub mod status;
pub mod uac1;
pub mod usbip;

use std::sync::Arc;

pub use midimaster_virtual_audio_protocol::{
    BYTES_PER_SAMPLE, CHANNELS, SAMPLE_RATE, SERVICE_DISPLAY_NAME, SERVICE_NAME,
};
pub const USBIP_ADDRESS: &str = "127.0.0.1:34240";
pub const BUS_ID: &str = "1-1";

pub fn development_identity() -> bool {
    option_env!("MIDIMASTER_USB_VID") == Some("FFFF")
}

pub fn create_device(status: Arc<status::ServiceStatus>) -> Arc<device::Device> {
    Arc::new(device::Device::new(
        u16::from_str_radix(env!("MIDIMASTER_USB_VID"), 16).expect("build VID"),
        u16::from_str_radix(env!("MIDIMASTER_USB_PID"), 16).expect("build PID"),
        status,
    ))
}
