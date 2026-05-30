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

pub fn application_name_matches(
    target_name: &str,
    process_path: Option<&str>,
    process_name: Option<&str>,
    display_name: Option<&str>,
    friendly_process_label: Option<&str>,
    humanized_process_name: Option<&str>,
) -> bool {
    let target = normalize_name(target_name);
    if target.is_empty() {
        return false;
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
            None
        ));
        assert!(application_name_matches(
            "obs64",
            None,
            Some("obs64.exe"),
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
            None
        ));
        assert!(application_name_matches(
            "Elgato Wave Link",
            None,
            Some("WaveLink.exe"),
            None,
            Some("Elgato Wave Link"),
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
            None
        ));
        assert!(!application_name_matches(
            "discord",
            Some("C:\\Apps\\Spotify.exe"),
            Some("Spotify.exe"),
            Some("Spotify"),
            None,
            None
        ));
    }
}
