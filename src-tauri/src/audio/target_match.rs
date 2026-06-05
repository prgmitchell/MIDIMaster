use std::path::Path;

fn normalize_name(value: &str) -> String {
    value.trim().to_lowercase()
}

fn file_stem(path_or_name: &str) -> Option<String> {
    Path::new(path_or_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(normalize_name)
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
        .filter(|part| !part.trim().is_empty())
        .last()
        .map(|part| part.to_string())
}

fn identity_candidate_matches(candidate: &str, target: &str) -> bool {
    normalize_name(candidate) == target
        || package_product_key(candidate)
            .map(|key| key == target)
            .unwrap_or(false)
}

pub fn application_name_matches(
    target_name: &str,
    process_path: Option<&str>,
    process_name: Option<&str>,
    display_name: Option<&str>,
    friendly_process_label: Option<&str>,
    humanized_process_name: Option<&str>,
    application_key: Option<&str>,
    package_family_name: Option<&str>,
    package_full_name: Option<&str>,
    application_user_model_id: Option<&str>,
) -> bool {
    let target = normalize_name(target_name);
    if target.is_empty() {
        return false;
    }

    let candidate_matches = |candidate: &str| identity_candidate_matches(candidate, &target);

    if application_key.map(candidate_matches).unwrap_or(false) {
        return true;
    }

    if application_user_model_id
        .map(|id| candidate_matches(id) || candidate_matches(&format!("aumid:{}", id)))
        .unwrap_or(false)
    {
        return true;
    }

    if package_family_name
        .map(|name| candidate_matches(name) || candidate_matches(&format!("package:{}", name)))
        .unwrap_or(false)
    {
        return true;
    }

    if package_full_name
        .map(|name| candidate_matches(name) || candidate_matches(&format!("package:{}", name)))
        .unwrap_or(false)
    {
        return true;
    }

    if process_path
        .and_then(file_stem)
        .map(|name| name == target)
        .unwrap_or(false)
    {
        return true;
    }

    if process_name
        .and_then(file_stem)
        .or_else(|| process_name.map(normalize_name))
        .map(|name| name == target)
        .unwrap_or(false)
    {
        return true;
    }

    if display_name
        .map(normalize_name)
        .map(|name| name == target)
        .unwrap_or(false)
    {
        return true;
    }

    if friendly_process_label
        .map(normalize_name)
        .map(|name| name == target)
        .unwrap_or(false)
    {
        return true;
    }

    humanized_process_name
        .map(normalize_name)
        .map(|name| name == target)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_path_stem_process_name_display_and_friendly_names() {
        assert!(application_name_matches(
            "spotify",
            Some("C:\\Apps\\Spotify.exe"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
        ));
        assert!(application_name_matches(
            "obs64",
            None,
            Some("obs64.exe"),
            None,
            None,
            None,
            None,
            None,
            None,
            None
        ));
        assert!(application_name_matches(
            "wave link",
            None,
            Some("WaveLink.exe"),
            Some("Wave Link"),
            None,
            None,
            None,
            None,
            None,
            None
        ));
        assert!(application_name_matches(
            "Elgato Wave Link",
            None,
            Some("WaveLink.exe"),
            None,
            Some("Elgato Wave Link"),
            None,
            None,
            None,
            None,
            None
        ));
    }

    #[test]
    fn matches_packaged_application_identities() {
        assert!(application_name_matches(
            "aumid:5319275a.whatsappdesktop_cv1g1gvanyjgm!app",
            None,
            None,
            Some("WhatsApp"),
            None,
            None,
            Some("aumid:5319275a.whatsappdesktop_cv1g1gvanyjgm!app"),
            Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App")
        ));
        assert!(application_name_matches(
            "package:5319275a.whatsappdesktop_cv1g1gvanyjgm",
            None,
            None,
            Some("WhatsApp"),
            None,
            None,
            None,
            Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
            None
        ));
        assert!(application_name_matches(
            "whatsappdesktop",
            None,
            None,
            Some("WhatsApp"),
            None,
            None,
            Some("package:5319275a.whatsappdesktop_cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
            None
        ));
        assert!(application_name_matches(
            "WhatsApp",
            Some("C:\\Program Files\\WindowsApps\\WhatsApp.Root.exe"),
            Some("WhatsApp.Root.exe"),
            Some("WhatsApp"),
            Some("WhatsApp Root"),
            Some("WhatsApp Root"),
            Some("package:5319275a.whatsappdesktop_cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
            None
        ));
        assert!(!application_name_matches(
            "msedgewebview2",
            Some("C:\\Program Files\\WindowsApps\\WhatsApp.Root.exe"),
            Some("WhatsApp.Root.exe"),
            Some("WhatsApp"),
            Some("WhatsApp Root"),
            Some("WhatsApp Root"),
            Some("package:5319275a.whatsappdesktop_cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
            Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
            None
        ));
    }

    #[test]
    fn rejects_empty_or_unrelated_targets() {
        assert!(!application_name_matches(
            "",
            Some("C:\\Apps\\Spotify.exe"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
        ));
        assert!(!application_name_matches(
            "discord",
            Some("C:\\Apps\\Spotify.exe"),
            Some("Spotify.exe"),
            Some("Spotify"),
            None,
            None,
            None,
            None,
            None,
            None
        ));
    }
}
