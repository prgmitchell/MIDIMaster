use super::*;
use windows::core::{w, Interface, PCWSTR};
use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWMINNOACTIVE;

#[test]
fn shortcuts_preserve_saved_arguments_and_working_directory() {
    let _com = windows_launch::ComApartment::new().unwrap();
    let root = std::env::temp_dir().join(format!("midimaster-launch-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let shortcut = root.join("Application shortcut.lnk");
    let target = std::env::current_exe().unwrap();
    let link: IShellLinkW =
        unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap() };
    let to_wide = |path: &Path| {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    unsafe {
        link.SetPath(PCWSTR(to_wide(&target).as_ptr())).unwrap();
        link.SetArguments(w!("--profile \"Saved Profile\" --flag"))
            .unwrap();
        link.SetWorkingDirectory(PCWSTR(to_wide(&root).as_ptr()))
            .unwrap();
        link.SetShowCmd(SW_SHOWMINNOACTIVE).unwrap();
        let persist: IPersistFile = link.cast().unwrap();
        persist
            .Save(PCWSTR(to_wide(&shortcut).as_ptr()), true)
            .unwrap();
    }
    let mut mapping = OpenApplicationMapping {
        path: shortcut.to_string_lossy().into(),
        display: "Application".into(),
        icon_data: None,
        arguments: String::new(),
    };
    let original = windows_launch::prepare(&mapping).unwrap();
    assert_eq!(
        original.path, shortcut,
        "Windows opens the original shortcut when no extra parameters are supplied"
    );
    assert!(original.arguments.is_empty());
    mapping.arguments = "--output \"C:\\Folder With Spaces\\out.txt\"".into();
    let expanded = windows_launch::prepare(&mapping).unwrap();
    assert_eq!(expanded.path, target);
    assert_eq!(
        expanded.arguments,
        "--profile \"Saved Profile\" --flag --output \"C:\\Folder With Spaces\\out.txt\""
    );
    assert_eq!(expanded.directory, Some(root.clone()));
    assert_eq!(expanded.show, SW_SHOWMINNOACTIVE);
    drop(link);
    std::fs::remove_file(shortcut).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn executable_arguments_round_trip_and_keep_windows_quoting() {
    let legacy: OpenApplicationMapping =
        serde_json::from_value(serde_json::json!({"path":"C:\\App.exe"})).unwrap();
    assert!(legacy.arguments.is_empty());
    let mapping: OpenApplicationMapping = serde_json::from_value(serde_json::json!({
        "path":"C:\\Program Files\\App.exe", "arguments":"--name \"two words\" --literal a&b"
    }))
    .unwrap();
    let request = windows_launch::prepare(&mapping).unwrap();
    assert_eq!(request.arguments, mapping.arguments);
    assert_eq!(
        serde_json::from_value::<OpenApplicationMapping>(serde_json::to_value(&mapping).unwrap())
            .unwrap(),
        mapping
    );
    assert!(supported_path(Path::new("App.EXE")));
    assert!(supported_path(Path::new("App.LNK")));
    assert!(!supported_path(Path::new("script.cmd")));
}
