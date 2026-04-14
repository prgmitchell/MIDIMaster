use crate::model::{self, LearnedControl};

#[derive(Debug, Clone)]
pub(crate) struct LearnCandidate {
    pub control: LearnedControl,
    pub last_seen_at: std::time::Instant,
    pub saw_zero: bool,
    pub saw_max: bool,
}

#[cfg(target_os = "windows")]
fn key_name_to_vk(name: &str) -> Option<u16> {
    let upper = name.trim().to_uppercase();
    match upper.as_str() {
        "CTRL" | "CONTROL" => Some(0x11),
        "SHIFT" => Some(0x10),
        "ALT" | "OPTION" => Some(0x12),
        "META" | "CMD" | "COMMAND" | "WIN" | "WINDOWS" => Some(0x5B),
        "SPACE" => Some(0x20),
        "ENTER" | "RETURN" => Some(0x0D),
        "TAB" => Some(0x09),
        "ESC" | "ESCAPE" => Some(0x1B),
        "BACKSPACE" => Some(0x08),
        "DELETE" | "DEL" => Some(0x2E),
        "INSERT" => Some(0x2D),
        "HOME" => Some(0x24),
        "END" => Some(0x23),
        "PAGEUP" => Some(0x21),
        "PAGEDOWN" => Some(0x22),
        "UP" | "ARROWUP" => Some(0x26),
        "DOWN" | "ARROWDOWN" => Some(0x28),
        "LEFT" | "ARROWLEFT" => Some(0x25),
        "RIGHT" | "ARROWRIGHT" => Some(0x27),
        "CAPSLOCK" => Some(0x14),
        "PRINTSCREEN" => Some(0x2C),
        "SCROLLLOCK" => Some(0x91),
        "PAUSE" => Some(0x13),
        _ => {
            if upper.len() == 1 {
                let b = upper.as_bytes()[0];
                if b.is_ascii_uppercase() || b.is_ascii_digit() {
                    return Some(b as u16);
                }
            }
            if let Some(rest) = upper.strip_prefix('F') {
                if let Ok(n) = rest.parse::<u8>() {
                    if (1..=24).contains(&n) {
                        return Some(0x70 + n as u16 - 1);
                    }
                }
            }
            None
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn send_media_key(vk: u16) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY,
    };

    let key_down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: KEYBD_EVENT_FLAGS(0),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    let key_up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    unsafe {
        SendInput(&[key_down, key_up], std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn send_hotkey(keys: &[String]) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY,
    };

    let mut vks: Vec<u16> = Vec::new();
    for key in keys {
        if let Some(vk) = key_name_to_vk(key) {
            if !vks.contains(&vk) {
                vks.push(vk);
            }
        }
    }
    if vks.is_empty() {
        return;
    }

    let mut events: Vec<INPUT> = Vec::with_capacity(vks.len() * 2);
    for vk in &vks {
        events.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(*vk),
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }
    for vk in vks.iter().rev() {
        events.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(*vk),
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }

    unsafe {
        SendInput(&events, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn send_media_key(_vk: u16) {
    // no-op on unsupported platforms
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn send_hotkey(_keys: &[String]) {
    // no-op on unsupported platforms
}

fn classify_cc_candidate(saw_zero: bool, saw_max: bool) -> model::BindingControlKind {
    if saw_zero && saw_max {
        model::BindingControlKind::Button
    } else {
        model::BindingControlKind::Continuous
    }
}

pub(crate) fn classify_learned_control(candidate: &LearnCandidate) -> LearnedControl {
    let mut learned = candidate.control.clone();
    learned.control_kind = match learned.msg_type {
        model::MidiMessageType::Note => model::BindingControlKind::Button,
        model::MidiMessageType::ControlChange => {
            classify_cc_candidate(candidate.saw_zero, candidate.saw_max)
        }
        model::MidiMessageType::PitchBend => model::BindingControlKind::Continuous,
    };
    learned
}
