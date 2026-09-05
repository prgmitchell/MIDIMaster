use super::*;

pub(super) fn package_path_by_full_name(package_full_name: &str) -> Option<String> {
    let wide = to_wide_string(package_full_name);
    let mut length = 0u32;
    let first = unsafe { GetPackagePathByFullName(PCWSTR(wide.as_ptr()), &mut length, None) };
    if first != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return None;
    }

    let mut buffer = vec![0u16; length as usize];
    let second = unsafe {
        GetPackagePathByFullName(
            PCWSTR(wide.as_ptr()),
            &mut length,
            Some(PWSTR(buffer.as_mut_ptr())),
        )
    };
    if second != ERROR_SUCCESS {
        return None;
    }

    string_from_wide_buffer(&buffer)
}

pub(super) fn best_package_icon_path(package_path: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    collect_package_icon_candidates(package_path, 0, &mut candidates);

    for manifest_logo in manifest_icon_base_paths(package_path) {
        if let Some(path) = candidates
            .iter()
            .filter(|path| package_icon_matches_manifest_logo(path, package_path, &manifest_logo))
            .max_by_key(|path| package_icon_variant_score(path))
        {
            return Some(path.clone());
        }
    }

    candidates
        .into_iter()
        .max_by_key(|path| package_icon_score(path))
        .filter(|path| package_icon_score(path) > 0)
}

pub(super) fn manifest_icon_base_paths(package_path: &Path) -> Vec<String> {
    let manifest_path = package_path.join("AppxManifest.xml");
    fs::read_to_string(manifest_path)
        .map(|contents| manifest_icon_base_paths_from_contents(&contents))
        .unwrap_or_default()
}

pub(in crate::audio::windows) fn package_display_name(
    identity: &ProcessIdentity,
) -> Option<String> {
    let package_full_name = identity.package_full_name.as_deref()?;
    package_path_by_full_name(package_full_name)
        .and_then(|path| package_display_name_from_manifest(Path::new(&path)))
}

pub(super) fn package_display_name_from_manifest(package_path: &Path) -> Option<String> {
    let manifest_path = package_path.join("AppxManifest.xml");
    fs::read_to_string(manifest_path)
        .ok()
        .and_then(|contents| package_display_name_from_manifest_contents(&contents))
}

pub(super) fn package_display_name_from_manifest_contents(contents: &str) -> Option<String> {
    [
        manifest_element(contents, "DisplayName"),
        manifest_attribute(contents, "DisplayName"),
    ]
    .into_iter()
    .flatten()
    .filter_map(|value| {
        resolve_indirect_display_name(&value).or_else(|| {
            if is_resource_display_name(&value) {
                None
            } else {
                Some(value.trim().to_string())
            }
        })
    })
    .find(|value| !value.trim().is_empty())
}

pub(super) fn manifest_icon_base_paths_from_contents(contents: &str) -> Vec<String> {
    let values = [
        manifest_attribute(contents, "Square44x44Logo"),
        manifest_element(contents, "Logo"),
        manifest_attribute(contents, "Logo"),
        manifest_attribute(contents, "Square150x150Logo"),
        manifest_attribute(contents, "Square71x71Logo"),
    ];
    let mut paths = Vec::new();

    for value in values.iter().filter_map(|value| value.as_deref()) {
        let normalized = normalize_package_icon_reference(value);
        if !normalized.is_empty() && !paths.contains(&normalized) {
            paths.push(normalized);
        }
    }

    paths
}

pub(super) fn manifest_attribute(contents: &str, attribute: &str) -> Option<String> {
    let mut offset = 0;
    while let Some(relative_start) = contents[offset..].find(attribute) {
        let start = offset + relative_start;
        let after_name = start + attribute.len();
        let before = contents[..start].chars().next_back();
        let has_name_boundary = before
            .map(|ch| ch.is_ascii_whitespace() || ch == '<')
            .unwrap_or(true);
        if !has_name_boundary {
            offset = after_name;
            continue;
        }

        let mut rest = contents[after_name..].trim_start();
        if !rest.starts_with('=') {
            offset = after_name;
            continue;
        }
        rest = rest[1..].trim_start();

        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            offset = after_name;
            continue;
        }

        let value = &rest[quote.len_utf8()..];
        let value_end = value.find(quote)?;
        return Some(value[..value_end].trim().to_string());
    }

    None
}

pub(super) fn manifest_element(contents: &str, element: &str) -> Option<String> {
    let open = format!("<{}>", element);
    let close = format!("</{}>", element);
    let value = contents.split_once(&open)?.1.split_once(&close)?.0.trim();

    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub(super) fn collect_package_icon_candidates(
    dir: &Path,
    depth: usize,
    candidates: &mut Vec<PathBuf>,
) {
    if depth > 4 || candidates.len() > 512 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_package_icon_candidates(&path, depth + 1, candidates);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("png"))
            .unwrap_or(false)
        {
            candidates.push(path);
        }
    }
}

pub(super) fn package_icon_score(path: &Path) -> i32 {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut score = package_icon_variant_score(path);

    if file_name.contains("square44x44logo") {
        score += 100;
    }
    if file_name.contains("applist")
        || file_name.contains("appicon")
        || file_name.contains("app_icon")
    {
        score += 90;
    }
    if file_name.contains("logo") {
        score += 40;
    }

    for bad in ["splash", "badge", "wide", "tile", "lockscreen"] {
        if file_name.contains(bad) {
            score -= 80;
        }
    }

    score
}

pub(super) fn package_icon_variant_score(path: &Path) -> i32 {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let full_path = path.to_string_lossy().to_ascii_lowercase();
    let mut score = 0;

    if file_name.contains("targetsize-48") || file_name.contains("targetsize-44") {
        score += 80;
    } else if file_name.contains("targetsize-64") {
        score += 70;
    } else if file_name.contains("scale-200") {
        score += 60;
    } else if file_name.contains("scale-100") {
        score += 50;
    } else if file_name.contains("targetsize-256") {
        score += 45;
    } else if file_name.contains("targetsize-32") {
        score += 35;
    }

    if file_name.contains("unplated") {
        score += 25;
    }
    if full_path.contains("\\assets\\") || full_path.contains("/assets/") {
        score += 10;
    }

    score
}

pub(super) fn package_icon_matches_manifest_logo(
    path: &Path,
    package_path: &Path,
    normalized_manifest_logo: &str,
) -> bool {
    let candidate = normalized_package_icon_path(path, package_path);

    candidate == normalized_manifest_logo
        || candidate
            .strip_prefix(normalized_manifest_logo)
            .map(|suffix| suffix.starts_with('.') || suffix.starts_with('_'))
            .unwrap_or(false)
}

pub(super) fn normalized_package_icon_path(path: &Path, package_path: &Path) -> String {
    let relative_path = path.strip_prefix(package_path).unwrap_or(path);
    normalize_package_icon_reference(&relative_path.to_string_lossy())
}

pub(super) fn normalize_package_icon_reference(value: &str) -> String {
    let normalized = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_start_matches(['\\', '/'])
        .replace('\\', "/")
        .to_ascii_lowercase();

    normalized
        .strip_suffix(".png")
        .or_else(|| normalized.strip_suffix(".ico"))
        .unwrap_or(&normalized)
        .to_string()
}
