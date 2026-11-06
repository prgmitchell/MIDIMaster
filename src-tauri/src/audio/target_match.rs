use std::path::Path;

pub(super) fn split_session_id(session_id: &str) -> (Option<&str>, &str) {
    session_id
        .split_once('|')
        .map(|(device, inner)| (Some(device), inner))
        .unwrap_or((None, session_id))
}

fn normalize_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn file_stem(path_or_name: &str) -> Option<String> {
    Path::new(path_or_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(normalize_name)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ApplicationMatchInfo<'a> {
    pub process_path: Option<&'a str>,
    pub process_name: Option<&'a str>,
    pub display_name: Option<&'a str>,
    pub friendly_process_label: Option<&'a str>,
    pub humanized_process_name: Option<&'a str>,
    pub application_key: Option<&'a str>,
    pub package_family_name: Option<&'a str>,
    pub package_full_name: Option<&'a str>,
    pub application_user_model_id: Option<&'a str>,
}

fn package_product_key(value: &str) -> Option<String> {
    let mut raw = normalize_name(value);
    raw = raw
        .strip_prefix("package:")
        .or_else(|| raw.strip_prefix("aumid:"))
        .unwrap_or(&raw)
        .to_string();
    raw = raw.split('!').next().unwrap_or(&raw).to_string();
    raw = raw.split('_').next().unwrap_or(&raw).to_string();
    raw.split('.')
        .rfind(|part| !part.trim().is_empty())
        .map(|part| part.to_string())
}

fn identity_candidate_matches(candidate: &str, target: &str) -> bool {
    normalize_name(candidate) == target
        || package_product_key(candidate)
            .map(|key| key == target)
            .unwrap_or(false)
}

pub fn application_name_matches(target_name: &str, info: ApplicationMatchInfo<'_>) -> bool {
    let target = normalize_name(target_name);
    if target.is_empty() {
        return false;
    }

    let candidate_matches = |candidate: &str| identity_candidate_matches(candidate, &target);

    if info.application_key.map(candidate_matches).unwrap_or(false) {
        return true;
    }

    if info
        .application_user_model_id
        .map(|id| candidate_matches(id) || candidate_matches(&format!("aumid:{}", id)))
        .unwrap_or(false)
    {
        return true;
    }

    if info
        .package_family_name
        .map(|name| candidate_matches(name) || candidate_matches(&format!("package:{}", name)))
        .unwrap_or(false)
    {
        return true;
    }

    if info
        .package_full_name
        .map(|name| candidate_matches(name) || candidate_matches(&format!("package:{}", name)))
        .unwrap_or(false)
    {
        return true;
    }

    if info
        .process_path
        .and_then(file_stem)
        .map(|name| name == target)
        .unwrap_or(false)
    {
        return true;
    }

    if info
        .process_name
        .and_then(file_stem)
        .or_else(|| info.process_name.map(normalize_name))
        .map(|name| name == target)
        .unwrap_or(false)
    {
        return true;
    }

    if info
        .display_name
        .map(normalize_name)
        .map(|name| name == target)
        .unwrap_or(false)
    {
        return true;
    }

    if info
        .friendly_process_label
        .map(normalize_name)
        .map(|name| name == target)
        .unwrap_or(false)
    {
        return true;
    }

    info.humanized_process_name
        .map(normalize_name)
        .map(|name| name == target)
        .unwrap_or(false)
}
