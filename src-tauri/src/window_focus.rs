fn normalize_process_name(value: &str) -> String {
    let raw = value.trim().to_lowercase();
    let filename = raw.rsplit(['\\', '/']).next().unwrap_or(&raw);
    filename
        .strip_suffix(".exe")
        .unwrap_or(filename)
        .to_string()
}

#[cfg(target_os = "windows")]
fn focus_window_target_matches(
    target_name: &str,
    identity: &crate::audio::windows::process_helpers::ProcessIdentity,
) -> bool {
    use crate::audio::target_match::{application_name_matches, ApplicationMatchInfo};

    // Discovery stores packaged apps by AUMID (or package family), not executable
    // name. Preserve those identifiers while accepting legacy executable targets.
    let target_name = target_name.trim().to_lowercase();
    let target_name = if target_name.starts_with("aumid:") || target_name.starts_with("package:") {
        target_name
    } else {
        normalize_process_name(&target_name)
    };
    application_name_matches(
        &target_name,
        ApplicationMatchInfo {
            process_path: identity.path.as_deref(),
            application_user_model_id: identity.application_user_model_id.as_deref(),
            package_family_name: identity.package_family_name.as_deref(),
            package_full_name: identity.package_full_name.as_deref(),
            ..Default::default()
        },
    )
}

#[cfg(target_os = "windows")]
struct FocusableWindow {
    hwnd: windows::Win32::Foundation::HWND,
    identity: crate::audio::windows::process_helpers::ProcessIdentity,
}

#[cfg(target_os = "windows")]
fn focusable_windows() -> Result<Vec<FocusableWindow>, String> {
    use crate::audio::windows::process_helpers::{query_process_identity, ProcessIdentity};
    use std::collections::HashMap;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    };

    #[derive(Default)]
    struct Snapshot {
        windows: Vec<FocusableWindow>,
        identities: HashMap<u32, ProcessIdentity>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows_core::BOOL {
        let snapshot = unsafe { &mut *(lparam.0 as *mut Snapshot) };
        // Minimized windows retain WS_VISIBLE; hidden tray/helper windows do not.
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return windows_core::BOOL(1);
        }
        if unsafe { GetWindowTextLengthW(hwnd) } <= 0 {
            return windows_core::BOOL(1);
        }

        let mut process_id = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
        let identity = snapshot
            .identities
            .entry(process_id)
            .or_insert_with(|| query_process_identity(process_id));
        snapshot.windows.push(FocusableWindow {
            hwnd,
            identity: identity.clone(),
        });
        windows_core::BOOL(1)
    }

    let mut snapshot = Snapshot::default();
    unsafe {
        EnumWindows(
            Some(enum_proc),
            LPARAM(&mut snapshot as *mut Snapshot as isize),
        )
    }
    .map_err(|err| format!("window_enumeration_failed: {err}"))?;
    Ok(snapshot.windows)
}

#[cfg(target_os = "windows")]
fn matching_window(
    application_name: &str,
    windows: &[FocusableWindow],
) -> Option<windows::Win32::Foundation::HWND> {
    windows
        .iter()
        .find(|window| focus_window_target_matches(application_name, &window.identity))
        .map(|window| window.hwnd)
}

#[cfg(target_os = "windows")]
pub(crate) fn filter_focusable_applications(
    application_names: Vec<String>,
) -> Result<Vec<String>, String> {
    if application_names.is_empty() {
        return Ok(Vec::new());
    }
    let windows = focusable_windows()?;
    let mut seen = std::collections::HashSet::new();
    Ok(application_names
        .into_iter()
        .filter(|name| matching_window(name, &windows).is_some() && seen.insert(name.clone()))
        .collect())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn filter_focusable_applications(
    _application_names: Vec<String>,
) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
pub(crate) fn focus_window_by_process_name(process_name: &str) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    if process_name.trim().is_empty() {
        return Err("missing_process_name".to_string());
    }
    let hwnd = matching_window(process_name, &focusable_windows()?)
        .ok_or_else(|| "window_not_found".to_string())?;
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if !SetForegroundWindow(hwnd).as_bool() {
            return Err("set_foreground_failed".to_string());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn focus_window_by_process_name(_process_name: &str) -> Result<(), String> {
    Err("unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    fn wave_link_identity() -> crate::audio::windows::process_helpers::ProcessIdentity {
        crate::audio::windows::process_helpers::ProcessIdentity {
            path: Some(r"C:\Program Files\WindowsApps\Elgato.WaveLink\Elgato.WaveLink.exe".into()),
            application_user_model_id: Some("Elgato.WaveLink_g54w8ztgkx496!App".into()),
            package_family_name: Some("Elgato.WaveLink_g54w8ztgkx496".into()),
            ..Default::default()
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn focus_window_matches_saved_wave_link_aumid() {
        assert!(focus_window_target_matches(
            "aumid:elgato.wavelink_g54w8ztgkx496!app",
            &wave_link_identity(),
        ));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn focus_window_matches_package_identity_without_executable_path() {
        let mut identity = wave_link_identity();
        identity.path = None;
        assert!(focus_window_target_matches(
            "  AUMID:ELGATO.WAVELINK_G54W8ZTGKX496!APP  ",
            &identity,
        ));
        identity.application_user_model_id = None;
        assert!(focus_window_target_matches(
            "package:elgato.wavelink_g54w8ztgkx496",
            &identity,
        ));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn focus_window_does_not_match_a_different_application_id() {
        let identity = wave_link_identity();
        for target in [
            "aumid:elgato.wavelink_g54w8ztgkx496!OtherApp",
            "aumid:elgato.wavelink_differentpublisher!app",
            "package:elgato.wavelink_differentpublisher",
            "",
            "   ",
        ] {
            assert!(!focus_window_target_matches(target, &identity), "{target}");
        }
        assert!(!focus_window_target_matches(
            "aumid:elgato.wavelink_g54w8ztgkx496!app",
            &Default::default(),
        ));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn focus_window_preserves_executable_name_and_path_matching() {
        let identity = wave_link_identity();
        for target in [
            "elgato.wavelink",
            " Elgato.WaveLink.EXE ",
            r"C:\Program Files\Elgato\Elgato.WaveLink.exe",
            "C:/Program Files/Elgato/Elgato.WaveLink.exe",
        ] {
            assert!(focus_window_target_matches(target, &identity), "{target}");
        }
        assert!(!focus_window_target_matches("notepad.exe", &identity));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn focusable_applications_track_open_minimized_and_tray_only_windows() {
        use windows::core::w;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, IsIconic, SetWindowTextW, ShowWindow, SW_HIDE,
            SW_SHOWMINNOACTIVE, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
        };

        struct TestWindow(HWND);
        impl Drop for TestWindow {
            fn drop(&mut self) {
                let _ = unsafe { DestroyWindow(self.0) };
            }
        }
        let window = TestWindow(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("MIDIMaster focus availability test"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                120,
                80,
                None,
                None,
                None,
                None,
            )
            .expect("create test window")
        });
        let target = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let candidates = vec![
            target.clone(),
            "midimaster-nonexistent-app".into(),
            target.clone(),
        ];

        assert!(filter_focusable_applications(candidates.clone())
            .unwrap()
            .is_empty());
        assert!(matching_window(&target, &focusable_windows().unwrap()).is_none());

        for show in [SW_SHOWNOACTIVATE, SW_SHOWMINNOACTIVE] {
            let _ = unsafe { ShowWindow(window.0, show) };
            assert_eq!(
                filter_focusable_applications(candidates.clone()).unwrap(),
                vec![target.clone()]
            );
            assert_eq!(
                matching_window(&target, &focusable_windows().unwrap()),
                Some(window.0)
            );
        }
        assert!(unsafe { IsIconic(window.0) }.as_bool());

        // A process can still exist after its main window is hidden to the tray.
        let _ = unsafe { ShowWindow(window.0, SW_HIDE) };
        assert!(filter_focusable_applications(candidates.clone())
            .unwrap()
            .is_empty());
        let _ = unsafe { ShowWindow(window.0, SW_SHOWNOACTIVATE) };
        assert_eq!(
            filter_focusable_applications(candidates.clone()).unwrap(),
            vec![target.clone()]
        );

        unsafe { SetWindowTextW(window.0, w!("")) }.unwrap();
        assert!(filter_focusable_applications(candidates)
            .unwrap()
            .is_empty());
    }
}
