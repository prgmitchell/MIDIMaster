use crate::model::OpenApplicationMapping;
use std::path::{Path, PathBuf};

pub(crate) fn launch(mapping: &OpenApplicationMapping) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mapping = mapping.clone();
        std::thread::spawn(move || {
            let _com = windows_launch::ComApartment::new()?;
            windows_launch::execute(&windows_launch::prepare(&mapping)?)
        })
        .join()
        .map_err(|_| "Application launcher failed".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = mapping;
        Err("Application launch is only supported on Windows".into())
    }
}

pub(crate) fn pick_application_path() -> Result<Option<PathBuf>, String> {
    #[cfg(windows)]
    {
        std::thread::spawn(windows_launch::pick)
            .join()
            .map_err(|_| "Application picker failed".to_string())?
    }
    #[cfg(not(windows))]
    {
        Err("Application selection is only supported on Windows".into())
    }
}

pub(crate) fn supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("lnk"))
}

#[cfg(windows)]
mod windows_launch {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, Interface, PCWSTR};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{
        Common::COMDLG_FILTERSPEC, FileOpenDialog, IFileOpenDialog, IShellLinkW, ShellExecuteW,
        ShellLink, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_NODEREFERENCELINKS,
        SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{SHOW_WINDOW_CMD, SW_SHOWNORMAL};

    pub(super) struct ComApartment;
    impl ComApartment {
        pub(super) fn new() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
                .map_err(|error| error.to_string())?;
            Ok(Self)
        }
    }
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    fn text(buffer: &[u16]) -> String {
        String::from_utf16_lossy(
            &buffer[..buffer
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(buffer.len())],
        )
    }

    pub(super) fn pick() -> Result<Option<PathBuf>, String> {
        let _com = ComApartment::new()?;
        let result = unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                    .map_err(|error| error.to_string())?;
            // Keep the .lnk itself. Resolving it in the picker discards its launch arguments.
            dialog
                .SetOptions(
                    dialog.GetOptions().map_err(|error| error.to_string())?
                        | FOS_FORCEFILESYSTEM
                        | FOS_FILEMUSTEXIST
                        | FOS_NODEREFERENCELINKS,
                )
                .map_err(|error| error.to_string())?;
            dialog
                .SetFileTypes(&[COMDLG_FILTERSPEC {
                    pszName: w!("Applications and shortcuts"),
                    pszSpec: w!("*.exe;*.lnk"),
                }])
                .map_err(|error| error.to_string())?;
            if let Err(error) = dialog.Show(None) {
                if error.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0) {
                    return Ok(None);
                }
                return Err(error.to_string());
            }
            let item = dialog.GetResult().map_err(|error| error.to_string())?;
            let name = item
                .GetDisplayName(SIGDN_FILESYSPATH)
                .map_err(|error| error.to_string())?;
            let path = name
                .to_string()
                .map(PathBuf::from)
                .map_err(|error| error.to_string());
            CoTaskMemFree(Some(name.0.cast()));
            path?
        };
        Ok(Some(result))
    }

    pub(super) struct LaunchRequest {
        pub path: PathBuf,
        pub arguments: String,
        pub directory: Option<PathBuf>,
        pub show: SHOW_WINDOW_CMD,
    }

    pub(super) fn prepare(mapping: &OpenApplicationMapping) -> Result<LaunchRequest, String> {
        let path = PathBuf::from(mapping.path.trim());
        let extra = mapping.arguments.trim();
        if mapping.path.contains('\0') || extra.contains('\0') {
            return Err("Invalid application parameters".into());
        }
        let shortcut = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"));
        if !shortcut || extra.is_empty() {
            return Ok(LaunchRequest {
                directory: if shortcut {
                    None
                } else {
                    path.parent().map(Path::to_path_buf)
                },
                path,
                arguments: extra.to_string(),
                show: SW_SHOWNORMAL,
            });
        }
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| error.to_string())?;
            let persist: IPersistFile = link.cast().map_err(|error| error.to_string())?;
            persist
                .Load(PCWSTR(wide(&path).as_ptr()), STGM_READ)
                .map_err(|error| error.to_string())?;
            let mut target = vec![0; 32768];
            let mut arguments = vec![0; 32768];
            let mut directory = vec![0; 32768];
            link.GetPath(&mut target, std::ptr::null_mut(), 0)
                .map_err(|error| error.to_string())?;
            link.GetArguments(&mut arguments)
                .map_err(|error| error.to_string())?;
            link.GetWorkingDirectory(&mut directory)
                .map_err(|error| error.to_string())?;
            let target = text(&target);
            if target.is_empty() {
                return Err(
                    "This shortcut does not have an application target for additional parameters"
                        .into(),
                );
            }
            let saved = text(&arguments);
            let directory = text(&directory);
            Ok(LaunchRequest {
                path: PathBuf::from(target),
                arguments: if saved.trim().is_empty() {
                    extra.to_string()
                } else {
                    format!("{} {}", saved.trim(), extra)
                },
                directory: if directory.is_empty() {
                    None
                } else {
                    Some(PathBuf::from(directory))
                },
                show: link.GetShowCmd().map_err(|error| error.to_string())?,
            })
        }
    }

    pub(super) fn execute(request: &LaunchRequest) -> Result<(), String> {
        let path = wide(&request.path);
        let parameters: Vec<u16> = request.arguments.encode_utf16().chain(Some(0)).collect();
        let directory = request.directory.as_ref().map(|value| wide(value));
        let code = unsafe {
            ShellExecuteW(
                Some(HWND::default()),
                w!("open"),
                PCWSTR(path.as_ptr()),
                if request.arguments.is_empty() {
                    PCWSTR::null()
                } else {
                    PCWSTR(parameters.as_ptr())
                },
                directory
                    .as_ref()
                    .map_or(PCWSTR::null(), |value| PCWSTR(value.as_ptr())),
                request.show,
            )
        }
        .0 as isize;
        if code > 32 {
            Ok(())
        } else {
            Err(format!(
                "Windows could not launch the application (error {code})"
            ))
        }
    }
}

#[cfg(all(test, windows))]
mod tests;
