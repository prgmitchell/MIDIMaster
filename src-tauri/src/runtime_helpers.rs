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
        "COMMA" | "," | "<" => Some(0xBC),
        "PERIOD" | "DOT" | "." | ">" => Some(0xBE),
        "SLASH" | "/" | "?" => Some(0xBF),
        "SEMICOLON" | ";" | ":" => Some(0xBA),
        "QUOTE" | "APOSTROPHE" | "'" | "\"" => Some(0xDE),
        "BACKQUOTE" | "BACKTICK" | "GRAVE" | "`" | "~" => Some(0xC0),
        "MINUS" | "DASH" | "-" | "_" => Some(0xBD),
        "EQUAL" | "EQUALS" | "=" | "+" => Some(0xBB),
        "BRACKETLEFT" | "LEFTBRACKET" | "[" | "{" => Some(0xDB),
        "BRACKETRIGHT" | "RIGHTBRACKET" | "]" | "}" => Some(0xDD),
        "BACKSLASH" | "\\" | "|" => Some(0xDC),
        "!" => Some(b'1' as u16),
        "@" => Some(b'2' as u16),
        "#" => Some(b'3' as u16),
        "$" => Some(b'4' as u16),
        "%" => Some(b'5' as u16),
        "^" => Some(b'6' as u16),
        "&" => Some(b'7' as u16),
        "*" => Some(b'8' as u16),
        "(" => Some(b'9' as u16),
        ")" => Some(b'0' as u16),
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

fn hotkey_vk_is_modifier(vk: u16) -> bool {
    matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B)
}

fn normalize_hotkey_vks(keys: &[String]) -> (Vec<u16>, Vec<String>) {
    let mut modifiers: Vec<u16> = Vec::new();
    let mut primaries: Vec<u16> = Vec::new();
    let mut unmapped: Vec<String> = Vec::new();

    for key in keys {
        match key_name_to_vk(key) {
            Some(vk) if hotkey_vk_is_modifier(vk) => {
                if !modifiers.contains(&vk) {
                    modifiers.push(vk);
                }
            }
            Some(vk) => {
                if !modifiers.contains(&vk) && !primaries.contains(&vk) {
                    primaries.push(vk);
                }
            }
            None => {
                let trimmed = key.trim();
                if !trimmed.is_empty() {
                    unmapped.push(trimmed.to_string());
                }
            }
        }
    }

    modifiers.extend(primaries);
    (modifiers, unmapped)
}

fn hotkey_input_vk(vk: u16) -> u16 {
    match vk {
        // Prefer left-side modifiers when a browser-captured hotkey stores
        // generic modifier names. Some global listeners distinguish them.
        0x10 => 0xA0, // VK_LSHIFT
        0x11 => 0xA2, // VK_LCONTROL
        0x12 => 0xA4, // VK_LMENU
        _ => vk,
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
pub(crate) fn open_path_with_shell_association(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let directory_path = path.parent().unwrap_or_else(|| std::path::Path::new(""));
    let directory: Vec<u16> = directory_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();

    let result = unsafe {
        ShellExecuteW(
            Some(HWND::default()),
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR(directory.as_ptr()),
            SW_SHOWNORMAL,
        )
    };
    let code = result.0 as isize;
    if code > 32 {
        return Ok(());
    }

    let reason = match code {
        2 => "file_not_found",
        3 => "path_not_found",
        5 => "access_denied",
        31 => "no_association",
        _ => "shell_execute_failed",
    };
    Err(format!("{}:{}", reason, code))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn open_path_with_shell_association(_path: &std::path::Path) -> Result<(), String> {
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
    use crate::run_logger;
    use std::thread;
    use std::time::Duration;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC_EX,
        VIRTUAL_KEY,
    };

    #[derive(Clone, Copy)]
    struct HotkeyInputKey {
        vk: u16,
        scan: u16,
        extended: bool,
    }

    fn scan_key_for_vk(vk: u16) -> Option<HotkeyInputKey> {
        let input_vk = hotkey_input_vk(vk);
        let scan = unsafe { MapVirtualKeyW(input_vk as u32, MAPVK_VK_TO_VSC_EX) };
        if scan == 0 {
            return None;
        }
        Some(HotkeyInputKey {
            vk,
            scan: (scan & 0xFF) as u16,
            extended: (scan & 0xFF00) != 0,
        })
    }

    fn key_input(key: HotkeyInputKey, key_up: bool) -> INPUT {
        let mut flags = KEYEVENTF_SCANCODE.0;
        if key_up {
            flags |= KEYEVENTF_KEYUP.0;
        }
        if key.extended {
            flags |= KEYEVENTF_EXTENDEDKEY.0;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: key.scan,
                    dwFlags: KEYBD_EVENT_FLAGS(flags),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send_input_batch(inputs: &[INPUT], event_name: &str) {
        if inputs.is_empty() {
            return;
        }
        unsafe {
            let sent = SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
            if sent != inputs.len() as u32 {
                run_logger::warn(
                    "bindings",
                    event_name,
                    &format!("sent={} expected={}", sent, inputs.len()),
                );
            }
        }
    }

    const HOTKEY_STAGE_MS: u64 = 12;
    const HOTKEY_HOLD_MS: u64 = 80;

    let (vks, unmapped) = normalize_hotkey_vks(keys);
    if !unmapped.is_empty() {
        run_logger::warn(
            "bindings",
            "hotkey_unmapped_keys",
            &format!("keys={}", unmapped.join("+")),
        );
    }
    if vks.is_empty() {
        run_logger::warn("bindings", "hotkey_no_mapped_keys", "");
        return;
    }

    let mut scan_unmapped = Vec::new();
    let input_keys = vks
        .iter()
        .filter_map(|vk| match scan_key_for_vk(*vk) {
            Some(key) => Some(key),
            None => {
                scan_unmapped.push(vk.to_string());
                None
            }
        })
        .collect::<Vec<_>>();
    if !scan_unmapped.is_empty() {
        run_logger::warn(
            "bindings",
            "hotkey_unmapped_scancodes",
            &format!("vks={}", scan_unmapped.join("+")),
        );
    }
    if input_keys.is_empty() {
        run_logger::warn("bindings", "hotkey_no_mapped_scancodes", "");
        return;
    }

    let modifiers = input_keys
        .iter()
        .copied()
        .filter(|key| hotkey_vk_is_modifier(key.vk))
        .collect::<Vec<_>>();
    let primaries = input_keys
        .iter()
        .copied()
        .filter(|key| !hotkey_vk_is_modifier(key.vk))
        .collect::<Vec<_>>();

    let modifier_down_events = modifiers
        .iter()
        .copied()
        .map(|key| key_input(key, false))
        .collect::<Vec<_>>();
    let primary_down_events = primaries
        .iter()
        .copied()
        .map(|key| key_input(key, false))
        .collect::<Vec<_>>();
    let primary_up_events = primaries
        .iter()
        .rev()
        .copied()
        .map(|key| key_input(key, true))
        .collect::<Vec<_>>();
    let modifier_up_events = modifiers
        .iter()
        .rev()
        .copied()
        .map(|key| key_input(key, true))
        .collect::<Vec<_>>();

    send_input_batch(&modifier_down_events, "hotkey_modifier_down_partial");
    thread::sleep(Duration::from_millis(HOTKEY_STAGE_MS));
    send_input_batch(&primary_down_events, "hotkey_primary_down_partial");
    thread::sleep(Duration::from_millis(HOTKEY_HOLD_MS));
    send_input_batch(&primary_up_events, "hotkey_primary_up_partial");
    thread::sleep(Duration::from_millis(HOTKEY_STAGE_MS));
    send_input_batch(&modifier_up_events, "hotkey_modifier_up_partial");
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

pub(crate) fn cc_learn_value_is_definitely_continuous(value: u8) -> bool {
    value != 0 && value != 127
}

pub(crate) fn classify_learned_control(candidate: &LearnCandidate) -> LearnedControl {
    let mut learned = candidate.control.clone();
    learned.control_kind = match learned.msg_type {
        model::MidiMessageType::Note | model::MidiMessageType::ProgramChange => {
            model::BindingControlKind::Button
        }
        model::MidiMessageType::ControlChange => {
            classify_cc_candidate(candidate.saw_zero, candidate.saw_max)
        }
        model::MidiMessageType::PitchBend => model::BindingControlKind::Continuous,
    };
    learned
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn normalizes_hotkey_modifiers_before_primary_keys() {
        let (vks, unmapped) = normalize_hotkey_vks(&keys(&["P", "Shift", "Ctrl", "Alt"]));

        assert_eq!(vks, vec![0x10, 0x11, 0x12, b'P' as u16]);
        assert!(unmapped.is_empty());
    }

    #[test]
    fn normalizes_hotkey_aliases_and_removes_duplicates() {
        let (vks, unmapped) = normalize_hotkey_vks(&keys(&[
            "Control", "Ctrl", "Option", "Alt", "Windows", "Meta", "F13",
        ]));

        assert_eq!(vks, vec![0x11, 0x12, 0x5B, 0x7C]);
        assert!(unmapped.is_empty());
    }

    #[test]
    fn normalizes_hotkey_reports_unmapped_keys() {
        let (vks, unmapped) = normalize_hotkey_vks(&keys(&["Ctrl", "Launch Mail", "P"]));

        assert_eq!(vks, vec![0x11, b'P' as u16]);
        assert_eq!(unmapped, vec!["Launch Mail".to_string()]);
    }

    #[test]
    fn normalizes_hotkey_oem_symbol_names() {
        let (vks, unmapped) = normalize_hotkey_vks(&keys(&["Ctrl", "Shift", "Comma", "Period"]));

        assert_eq!(vks, vec![0x11, 0x10, 0xBC, 0xBE]);
        assert!(unmapped.is_empty());
    }

    #[test]
    fn normalizes_hotkey_shifted_symbol_aliases_to_base_keys() {
        let (vks, unmapped) = normalize_hotkey_vks(&keys(&["<", ">", "!", "+"]));

        assert_eq!(vks, vec![0xBC, 0xBE, b'1' as u16, 0xBB]);
        assert!(unmapped.is_empty());
    }

    #[test]
    fn hotkey_input_vk_prefers_left_modifiers_for_generic_names() {
        assert_eq!(hotkey_input_vk(0x10), 0xA0);
        assert_eq!(hotkey_input_vk(0x11), 0xA2);
        assert_eq!(hotkey_input_vk(0x12), 0xA4);
        assert_eq!(hotkey_input_vk(0x5B), 0x5B);
        assert_eq!(hotkey_input_vk(b'P' as u16), b'P' as u16);
    }
}
