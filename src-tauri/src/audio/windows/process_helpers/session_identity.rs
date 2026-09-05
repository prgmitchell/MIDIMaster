use super::*;

pub(in crate::audio::windows) fn session_display_name(raw_name: Option<&str>) -> Option<String> {
    let raw = raw_name.map(str::trim).filter(|name| !name.is_empty())?;
    resolve_indirect_display_name(raw).or_else(|| Some(raw.to_string()))
}

pub(in crate::audio::windows) fn session_identifier(
    control2: &IAudioSessionControl2,
    process_id: u32,
) -> Option<String> {
    let identifier = unsafe { control2.GetSessionIdentifier() }.ok()?;
    let identifier = owned_pwstr_to_string(identifier)?;
    if identifier.trim().is_empty() {
        None
    } else {
        Some(format!("{}:{}", process_id, identifier))
    }
}

pub(in crate::audio::windows) fn is_resource_display_name(name: &str) -> bool {
    name.trim().starts_with('@')
}

pub(in crate::audio::windows) fn stable_application_key(
    identity: &ProcessIdentity,
    process_path: Option<&str>,
    process_name: Option<&str>,
    display_name: Option<&str>,
) -> Option<String> {
    if let Some(aumid) = identity.application_user_model_id.as_deref() {
        let value = normalize_key_part(aumid)?;
        return Some(format!("aumid:{}", value));
    }

    if let Some(package_family) = identity.package_family_name.as_deref() {
        let value = normalize_key_part(package_family)?;
        return Some(format!("package:{}", value));
    }

    process_path
        .and_then(file_stem_key)
        .or_else(|| process_name.and_then(file_stem_key))
        .or_else(|| {
            process_name
                .filter(|name| !is_pid_label(name) && !is_webview2_label(name))
                .and_then(normalize_key_part)
        })
        .or_else(|| {
            display_name
                .filter(|name| !is_pid_label(name) && !is_resource_display_name(name))
                .and_then(normalize_key_part)
        })
}

pub(in crate::audio::windows) fn package_label(identity: &ProcessIdentity) -> Option<String> {
    identity
        .package_family_name
        .as_deref()
        .or(identity.package_full_name.as_deref())
        .and_then(|value| {
            let package_name = value.split('_').next().unwrap_or(value);
            let product = package_name
                .split('.')
                .rfind(|part| !part.trim().is_empty())
                .unwrap_or(package_name);
            let label = humanize_label(product);
            if label.is_empty() {
                None
            } else {
                Some(label)
            }
        })
}

pub(in crate::audio::windows) fn should_skip_session(
    process_id: u32,
    display_name: &Option<String>,
    process_name: &Option<String>,
    process_path: &Option<String>,
    friendly_name: &str,
    application_key: &Option<String>,
    identity: &ProcessIdentity,
) -> bool {
    let has_usable_identity = application_key.is_some()
        || identity.has_package_identity()
        || process_path.is_some()
        || process_name
            .as_deref()
            .map(|name| !is_pid_label(name))
            .unwrap_or(false)
        || display_name
            .as_deref()
            .map(|name| !is_resource_display_name(name) && !is_pid_label(name))
            .unwrap_or(false);

    if process_id == 0 && !has_usable_identity {
        return true;
    }

    let blocked = ["audiosrv", "audiodg", "midimaster"];

    let mut labels = Vec::new();
    labels.push(canonical_label(friendly_name));
    if let Some(name) = display_name.as_ref() {
        labels.push(canonical_label(name));
    }
    if let Some(name) = process_name.as_ref() {
        labels.push(canonical_label(name));
    }
    if let Some(path) = process_path.as_ref() {
        if let Some(stem) = Path::new(path).file_stem().and_then(|s| s.to_str()) {
            labels.push(canonical_label(stem));
        }
    }
    if let Some(key) = application_key.as_ref() {
        labels.push(canonical_label(key));
    }
    if let Some(name) = identity.application_user_model_id.as_ref() {
        labels.push(canonical_label(name));
    }
    if let Some(name) = identity.package_family_name.as_ref() {
        labels.push(canonical_label(name));
    }
    if let Some(name) = identity.package_full_name.as_ref() {
        labels.push(canonical_label(name));
    }

    if labels
        .iter()
        .any(|label| blocked.iter().any(|blocked| label == blocked))
    {
        return true;
    }

    let has_real_display_name = display_name
        .as_deref()
        .map(|name| {
            let label = canonical_label(name);
            !label.is_empty() && !is_pid_label(name) && !is_webview2_label(&label)
        })
        .unwrap_or(false);
    if labels.iter().any(|label| is_webview2_label(label))
        && !identity.has_package_identity()
        && !has_real_display_name
    {
        return true;
    }

    // Filter out nameless processes that fall back to "PID <id>" or "Unknown"
    if (is_pid_label(friendly_name) || friendly_name == "Unknown") && !has_usable_identity {
        return true;
    }

    let is_svchost = labels.iter().any(|label| label == "svchost");
    if is_svchost && display_name.is_none() {
        return true;
    }

    false
}

pub(in crate::audio::windows) fn canonical_label(label: &str) -> String {
    let trimmed = label.trim().to_lowercase();
    let trimmed = trimmed.strip_suffix(".exe").unwrap_or(&trimmed);
    let trimmed = trimmed.strip_suffix(".dll").unwrap_or(trimmed);
    trimmed.to_string()
}

pub(super) fn is_pid_label(label: &str) -> bool {
    label.trim().to_ascii_lowercase().starts_with("pid ")
}

pub(super) fn is_webview2_label(label: &str) -> bool {
    canonical_label(label) == "msedgewebview2"
}

pub(super) fn normalize_key_part(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_lowercase())
    }
}

pub(super) fn file_stem_key(path_or_name: &str) -> Option<String> {
    Path::new(path_or_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(normalize_key_part)
        .filter(|name| !is_pid_label(name) && !is_webview2_label(name))
}

pub(in crate::audio::windows) fn friendly_process_label(path: &str) -> Option<String> {
    let stem = Path::new(path).file_stem()?.to_string_lossy();
    let cleaned = stem.replace(['_', '-'], " ");
    let label = cleaned
        .split_whitespace()
        .map(humanize_word)
        .collect::<Vec<_>>()
        .join(" ");
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

pub(in crate::audio::windows) fn humanize_label(label: &str) -> String {
    let cleaned = label.replace(['_', '-'], " ");
    cleaned
        .split_whitespace()
        .map(humanize_word)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(in crate::audio::windows) fn humanize_word(word: &str) -> String {
    if word.chars().any(|ch| ch.is_uppercase()) {
        return word.to_string();
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase()),
        None => String::new(),
    }
}
