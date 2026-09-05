#[path = "process_helpers/process_identity.rs"]
mod process_identity;
pub(super) use process_identity::*;
#[path = "process_helpers/session_identity.rs"]
mod session_identity;
pub(super) use session_identity::*;
#[path = "process_helpers/packages.rs"]
mod packages;
pub(super) use packages::*;
#[path = "process_helpers/icons.rs"]
mod icons;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
pub use icons::extract_executable_icon_base64;
#[cfg(test)]
use icons::*;
pub(super) use icons::{icon_data_for_icon_path, icon_data_for_package, icon_data_for_path};
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE,
};
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Media::Audio::IAudioSessionControl2;
use windows::Win32::Storage::Packaging::Appx::{
    GetApplicationUserModelId, GetPackageFamilyName, GetPackageFullName, GetPackagePathByFullName,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{ExtractIconExW, SHLoadIndirectString};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ProcessIdentity {
    pub path: Option<String>,
    pub application_user_model_id: Option<String>,
    pub package_family_name: Option<String>,
    pub package_full_name: Option<String>,
}

impl ProcessIdentity {
    pub(super) fn has_package_identity(&self) -> bool {
        self.application_user_model_id.is_some()
            || self.package_family_name.is_some()
            || self.package_full_name.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessSnapshotEntry {
    process_id: u32,
    parent_process_id: u32,
    exe_name: String,
}

pub(super) fn to_wide_string(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn string_from_wide_buffer(buffer: &[u16]) -> Option<String> {
    let len = buffer
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(buffer.len());
    if len == 0 {
        return None;
    }
    let text = OsString::from_wide(&buffer[..len])
        .to_string_lossy()
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub(super) fn pwstr_to_string(ptr: PWSTR) -> Option<String> {
    if ptr.0.is_null() {
        return None;
    }
    unsafe {
        let mut length = 0;
        while *ptr.0.add(length) != 0 {
            length += 1;
        }
        let slice = std::slice::from_raw_parts(ptr.0, length);
        let os_string = OsString::from_wide(slice);
        Some(os_string.to_string_lossy().to_string())
    }
}

pub(super) fn owned_pwstr_to_string(ptr: PWSTR) -> Option<String> {
    let output = pwstr_to_string(ptr);
    if !ptr.0.is_null() {
        unsafe {
            CoTaskMemFree(Some(ptr.0 as _));
        }
    }
    output
}

pub(super) fn resolve_indirect_display_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !is_resource_display_name(trimmed) {
        return Some(trimmed.to_string());
    }

    let source = to_wide_string(trimmed);
    let mut buffer = vec![0u16; 2048];
    unsafe { SHLoadIndirectString(PCWSTR(source.as_ptr()), &mut buffer, None).ok()? };
    string_from_wide_buffer(&buffer)
}

#[cfg(test)]
#[path = "process_helpers/tests.rs"]
mod tests;
