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

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(target_name: &str, info: ApplicationMatchInfo<'_>) -> bool {
        application_name_matches(target_name, info)
    }

    #[test]
    fn matches_path_stem_process_name_display_and_friendly_names() {
        assert!(matches(
            "spotify",
            ApplicationMatchInfo {
                process_path: Some("C:\\Apps\\Spotify.exe"),
                ..Default::default()
            }
        ));
        assert!(matches(
            "obs64",
            ApplicationMatchInfo {
                process_name: Some("obs64.exe"),
                ..Default::default()
            }
        ));
        assert!(matches(
            "wave link",
            ApplicationMatchInfo {
                process_name: Some("WaveLink.exe"),
                display_name: Some("Wave Link"),
                ..Default::default()
            }
        ));
        assert!(matches(
            "Elgato Wave Link",
            ApplicationMatchInfo {
                process_name: Some("WaveLink.exe"),
                friendly_process_label: Some("Elgato Wave Link"),
                ..Default::default()
            }
        ));
    }

    #[test]
    fn matches_packaged_application_identities() {
        assert!(matches(
            "aumid:5319275a.whatsappdesktop_cv1g1gvanyjgm!app",
            ApplicationMatchInfo {
                display_name: Some("WhatsApp"),
                application_key: Some("aumid:5319275a.whatsappdesktop_cv1g1gvanyjgm!app"),
                package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
                package_full_name: Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
                application_user_model_id: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"),
                ..Default::default()
            }
        ));
        assert!(matches(
            "package:5319275a.whatsappdesktop_cv1g1gvanyjgm",
            ApplicationMatchInfo {
                display_name: Some("WhatsApp"),
                package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
                package_full_name: Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
                ..Default::default()
            }
        ));
        assert!(matches(
            "whatsappdesktop",
            ApplicationMatchInfo {
                display_name: Some("WhatsApp"),
                application_key: Some("package:5319275a.whatsappdesktop_cv1g1gvanyjgm"),
                package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
                package_full_name: Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
                ..Default::default()
            }
        ));
        assert!(matches(
            "WhatsApp",
            ApplicationMatchInfo {
                process_path: Some("C:\\Program Files\\WindowsApps\\WhatsApp.Root.exe"),
                process_name: Some("WhatsApp.Root.exe"),
                display_name: Some("WhatsApp"),
                friendly_process_label: Some("WhatsApp Root"),
                humanized_process_name: Some("WhatsApp Root"),
                application_key: Some("package:5319275a.whatsappdesktop_cv1g1gvanyjgm"),
                package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
                package_full_name: Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
                ..Default::default()
            }
        ));
        assert!(!matches(
            "msedgewebview2",
            ApplicationMatchInfo {
                process_path: Some("C:\\Program Files\\WindowsApps\\WhatsApp.Root.exe"),
                process_name: Some("WhatsApp.Root.exe"),
                display_name: Some("WhatsApp"),
                friendly_process_label: Some("WhatsApp Root"),
                humanized_process_name: Some("WhatsApp Root"),
                application_key: Some("package:5319275a.whatsappdesktop_cv1g1gvanyjgm"),
                package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm"),
                package_full_name: Some("5319275A.WhatsAppDesktop_1.0.0.0_x64__cv1g1gvanyjgm"),
                ..Default::default()
            }
        ));
    }

    #[test]
    fn rejects_empty_or_unrelated_targets() {
        assert!(!matches(
            "",
            ApplicationMatchInfo {
                process_path: Some("C:\\Apps\\Spotify.exe"),
                ..Default::default()
            }
        ));
        assert!(!matches(
            "discord",
            ApplicationMatchInfo {
                process_path: Some("C:\\Apps\\Spotify.exe"),
                process_name: Some("Spotify.exe"),
                display_name: Some("Spotify"),
                ..Default::default()
            }
        ));
    }
}
