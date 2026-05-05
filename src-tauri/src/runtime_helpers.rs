use crate::model::{self, LearnedControl};

#[derive(Debug, Clone)]
pub(crate) struct LearnCandidate {
    pub control: LearnedControl,
    pub last_seen_at: std::time::Instant,
    pub saw_zero: bool,
    pub saw_max: bool,
}

fn normalize_process_name(value: &str) -> String {
    let raw = value.trim().to_lowercase();
    let filename = raw.rsplit(['\\', '/']).next().unwrap_or(&raw);
    filename
        .strip_suffix(".exe")
        .unwrap_or(filename)
        .to_string()
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
fn query_process_path(process_id: u32) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if process_id == 0 {
        return None;
    }
    let handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    if handle.is_invalid() {
        return None;
    }
    let mut buffer = vec![0u16; 4096];
    let mut size = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    if result.is_err() {
        return None;
    }
    buffer.truncate(size as usize);
    Some(OsString::from_wide(&buffer).to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn focus_window_by_process_name(process_name: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    struct Search {
        needle: String,
        hwnd: HWND,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows_core::BOOL {
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return windows_core::BOOL(1);
        }
        if unsafe { GetWindowTextLengthW(hwnd) } <= 0 {
            return windows_core::BOOL(1);
        }

        let mut process_id = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
        let Some(path) = query_process_path(process_id) else {
            return windows_core::BOOL(1);
        };
        if normalize_process_name(&path) != search.needle {
            return windows_core::BOOL(1);
        }

        search.hwnd = hwnd;
        windows_core::BOOL(0)
    }

    let needle = normalize_process_name(process_name);
    if needle.is_empty() {
        return Err("missing_process_name".to_string());
    }

    let mut search = Search {
        needle,
        hwnd: HWND::default(),
    };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut search as *mut Search as isize));
    }
    if search.hwnd.is_invalid() {
        return Err("window_not_found".to_string());
    }
    unsafe {
        if IsIconic(search.hwnd).as_bool() {
            let _ = ShowWindow(search.hwnd, SW_RESTORE);
        }
        if !SetForegroundWindow(search.hwnd).as_bool() {
            return Err("set_foreground_failed".to_string());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn focus_window_by_process_name(_process_name: &str) -> Result<(), String> {
    Err("unsupported_platform".to_string())
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
