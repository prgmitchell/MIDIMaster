fn parse_hex_env(name: &str, default: u16) -> u16 {
    let Ok(value) = std::env::var(name) else {
        return default;
    };
    let raw = value.strip_prefix("0x").unwrap_or(&value);
    u16::from_str_radix(raw, 16)
        .unwrap_or_else(|_| panic!("{name} must be a 16-bit hexadecimal value"))
}

fn main() {
    println!("cargo:rerun-if-env-changed=MIDIMASTER_USB_VID");
    println!("cargo:rerun-if-env-changed=MIDIMASTER_USB_PID");
    let vid = parse_hex_env("MIDIMASTER_USB_VID", 0xffff);
    let pid = parse_hex_env("MIDIMASTER_USB_PID", 0xca01);
    println!("cargo:rustc-env=MIDIMASTER_USB_VID={vid:04X}");
    println!("cargo:rustc-env=MIDIMASTER_USB_PID={pid:04X}");
}
