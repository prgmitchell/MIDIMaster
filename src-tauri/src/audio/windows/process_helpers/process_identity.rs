use super::*;

pub(in crate::audio::windows) fn query_effective_process_identity(
    process_id: u32,
) -> ProcessIdentity {
    let identity = query_process_identity(process_id);
    if !process_identity_is_webview2(&identity) {
        return identity;
    }

    process_snapshot_entries()
        .and_then(|snapshot| {
            resolve_webview2_owner_identity(
                process_id,
                &identity,
                &snapshot,
                query_process_identity,
            )
        })
        .unwrap_or(identity)
}

pub(in crate::audio::windows) fn query_process_identity(process_id: u32) -> ProcessIdentity {
    if process_id == 0 {
        return ProcessIdentity::default();
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok();
    let Some(handle) = handle else {
        return ProcessIdentity::default();
    };
    if handle.is_invalid() {
        return ProcessIdentity::default();
    }

    let identity = ProcessIdentity {
        path: query_process_path_from_handle(handle),
        application_user_model_id: query_app_model_string(
            handle,
            AppModelString::ApplicationUserModelId,
        ),
        package_family_name: query_app_model_string(handle, AppModelString::PackageFamilyName),
        package_full_name: query_app_model_string(handle, AppModelString::PackageFullName),
    };

    let _ = unsafe { CloseHandle(handle) };
    identity
}

pub(super) fn query_process_path_from_handle(handle: HANDLE) -> Option<String> {
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
    if result.is_err() {
        return None;
    }
    buffer.truncate(size as usize);
    Some(OsString::from_wide(&buffer).to_string_lossy().to_string())
}

enum AppModelString {
    ApplicationUserModelId,
    PackageFamilyName,
    PackageFullName,
}

fn query_app_model_string(handle: HANDLE, kind: AppModelString) -> Option<String> {
    let mut length = 0u32;
    let first = unsafe {
        match kind {
            AppModelString::ApplicationUserModelId => {
                GetApplicationUserModelId(handle, &mut length, None)
            }
            AppModelString::PackageFamilyName => GetPackageFamilyName(handle, &mut length, None),
            AppModelString::PackageFullName => GetPackageFullName(handle, &mut length, None),
        }
    };

    if first == APPMODEL_ERROR_NO_PACKAGE || length == 0 {
        return None;
    }
    if first != ERROR_INSUFFICIENT_BUFFER && first != ERROR_SUCCESS {
        return None;
    }

    let mut buffer = vec![0u16; length as usize];
    let second = unsafe {
        match kind {
            AppModelString::ApplicationUserModelId => {
                GetApplicationUserModelId(handle, &mut length, Some(PWSTR(buffer.as_mut_ptr())))
            }
            AppModelString::PackageFamilyName => {
                GetPackageFamilyName(handle, &mut length, Some(PWSTR(buffer.as_mut_ptr())))
            }
            AppModelString::PackageFullName => {
                GetPackageFullName(handle, &mut length, Some(PWSTR(buffer.as_mut_ptr())))
            }
        }
    };
    if second != ERROR_SUCCESS {
        return None;
    }

    string_from_wide_buffer(&buffer)
}

pub(super) fn process_snapshot_entries() -> Option<Vec<ProcessSnapshotEntry>> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        let _ = unsafe { CloseHandle(snapshot) };
        return None;
    }

    let mut entries = Vec::new();
    loop {
        entries.push(ProcessSnapshotEntry {
            process_id: entry.th32ProcessID,
            parent_process_id: entry.th32ParentProcessID,
            exe_name: string_from_wide_buffer(&entry.szExeFile).unwrap_or_default(),
        });

        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }

    let _ = unsafe { CloseHandle(snapshot) };
    Some(entries)
}

pub(super) fn resolve_webview2_owner_identity(
    process_id: u32,
    identity: &ProcessIdentity,
    snapshot: &[ProcessSnapshotEntry],
    mut identity_for_process: impl FnMut(u32) -> ProcessIdentity,
) -> Option<ProcessIdentity> {
    if !process_identity_is_webview2(identity) {
        return None;
    }

    let by_id = snapshot
        .iter()
        .map(|entry| (entry.process_id, entry))
        .collect::<HashMap<_, _>>();
    let mut visited = HashSet::new();
    let mut current_id = process_id;

    for _ in 0..8 {
        if !visited.insert(current_id) {
            break;
        }

        let parent_id = by_id.get(&current_id)?.parent_process_id;
        if parent_id == 0 || visited.contains(&parent_id) {
            break;
        }

        let parent_identity = identity_for_process(parent_id);
        let parent_is_webview2 = by_id
            .get(&parent_id)
            .map(|entry| {
                is_webview2_label(&entry.exe_name) || process_identity_is_webview2(&parent_identity)
            })
            .unwrap_or_else(|| process_identity_is_webview2(&parent_identity));

        if parent_is_webview2 {
            current_id = parent_id;
            continue;
        }

        return parent_identity
            .has_package_identity()
            .then_some(parent_identity);
    }

    None
}

pub(super) fn process_identity_is_webview2(identity: &ProcessIdentity) -> bool {
    identity
        .path
        .as_deref()
        .and_then(|path| Path::new(path).file_stem())
        .and_then(|stem| stem.to_str())
        .map(is_webview2_label)
        .unwrap_or(false)
}
