use super::*;
use std::ptr;
use windows::Win32::System::Com::CoTaskMemAlloc;

#[test]
fn legacy_icon_alpha_uses_the_and_mask_when_color_alpha_is_empty() {
    let mut pixels = vec![10, 20, 30, 0, 40, 50, 60, 0];
    let mask = vec![0, 0, 0, 0, 255, 255, 255, 0];

    restore_legacy_icon_alpha(&mut pixels, Some(&mask));

    assert_eq!(pixels[3], 255);
    assert_eq!(pixels[7], 0);
}

#[test]
fn modern_icon_alpha_is_preserved() {
    let mut pixels = vec![10, 20, 30, 128, 40, 50, 60, 0];
    let original = pixels.clone();

    restore_legacy_icon_alpha(&mut pixels, None);

    assert_eq!(pixels, original);
}

#[test]
fn owned_pwstr_to_string_copies_and_frees_com_allocated_memory() {
    let text: Vec<u16> = "MIDIMaster".encode_utf16().chain(Some(0)).collect();
    let byte_len = text.len() * std::mem::size_of::<u16>();
    let raw = unsafe { CoTaskMemAlloc(byte_len) } as *mut u16;
    assert!(!raw.is_null());

    unsafe {
        ptr::copy_nonoverlapping(text.as_ptr(), raw, text.len());
    }

    let output = owned_pwstr_to_string(PWSTR(raw));
    assert_eq!(output.as_deref(), Some("MIDIMaster"));
}

#[test]
fn stable_application_key_prefers_aumid_then_package() {
    let identity = ProcessIdentity {
        application_user_model_id: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App".to_string()),
        package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm".to_string()),
        ..Default::default()
    };

    assert_eq!(
        stable_application_key(&identity, None, None, Some("WhatsApp")).as_deref(),
        Some("aumid:5319275a.whatsappdesktop_cv1g1gvanyjgm!app")
    );

    let identity = ProcessIdentity {
        package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm".to_string()),
        ..Default::default()
    };
    assert_eq!(
        stable_application_key(&identity, None, Some("PID 1234"), Some("WhatsApp")).as_deref(),
        Some("package:5319275a.whatsappdesktop_cv1g1gvanyjgm")
    );
}

#[test]
fn stable_application_key_does_not_use_pid_fallback() {
    assert_eq!(
        stable_application_key(
            &ProcessIdentity::default(),
            None,
            Some("PID 1234"),
            Some("PID 1234")
        ),
        None
    );
}

#[test]
fn stable_application_key_does_not_use_webview2_fallback() {
    assert_eq!(
        stable_application_key(
            &ProcessIdentity::default(),
            Some(
                "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
            ),
            Some("msedgewebview2.exe"),
            Some("WhatsApp")
        )
        .as_deref(),
        Some("whatsapp")
    );
}

#[test]
fn webview_owner_resolution_prefers_packaged_parent() {
    let raw_webview = ProcessIdentity {
        path: Some(
            "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
                .to_string(),
        ),
        ..Default::default()
    };
    let whatsapp = ProcessIdentity {
        path: Some(
            "C:\\Program Files\\WindowsApps\\5319275A.WhatsAppDesktop_2.2620.102.0_x64__cv1g1gvanyjgm\\WhatsApp.Root.exe"
                .to_string(),
        ),
        package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm".to_string()),
        package_full_name: Some(
            "5319275A.WhatsAppDesktop_2.2620.102.0_x64__cv1g1gvanyjgm".to_string(),
        ),
        ..Default::default()
    };
    let snapshot = vec![
        ProcessSnapshotEntry {
            process_id: 20164,
            parent_process_id: 14788,
            exe_name: "msedgewebview2.exe".to_string(),
        },
        ProcessSnapshotEntry {
            process_id: 14788,
            parent_process_id: 15928,
            exe_name: "msedgewebview2.exe".to_string(),
        },
        ProcessSnapshotEntry {
            process_id: 15928,
            parent_process_id: 7728,
            exe_name: "WhatsApp.Root.exe".to_string(),
        },
    ];

    let owner = resolve_webview2_owner_identity(20164, &raw_webview, &snapshot, |pid| {
        if pid == 15928 {
            whatsapp.clone()
        } else {
            raw_webview.clone()
        }
    });

    assert_eq!(owner, Some(whatsapp));
}

#[test]
fn webview_owner_resolution_ignores_unpackaged_midimaster_parent() {
    let raw_webview = ProcessIdentity {
        path: Some(
            "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
                .to_string(),
        ),
        ..Default::default()
    };
    let midimaster = ProcessIdentity {
        path: Some("C:\\Program Files\\MIDIMaster\\midimaster.exe".to_string()),
        ..Default::default()
    };
    let snapshot = vec![
        ProcessSnapshotEntry {
            process_id: 22584,
            parent_process_id: 11648,
            exe_name: "msedgewebview2.exe".to_string(),
        },
        ProcessSnapshotEntry {
            process_id: 11648,
            parent_process_id: 1000,
            exe_name: "midimaster.exe".to_string(),
        },
    ];

    let owner = resolve_webview2_owner_identity(22584, &raw_webview, &snapshot, |pid| {
        if pid == 11648 {
            midimaster.clone()
        } else {
            raw_webview.clone()
        }
    });

    assert_eq!(owner, None);
}

#[test]
fn skip_pid_only_sessions_but_keep_packaged_sessions() {
    assert!(should_skip_session(
        1234,
        &None,
        &Some("PID 1234".to_string()),
        &None,
        "PID 1234",
        &None,
        &ProcessIdentity::default()
    ));

    let identity = ProcessIdentity {
        package_family_name: Some("5319275A.WhatsAppDesktop_cv1g1gvanyjgm".to_string()),
        ..Default::default()
    };
    let application_key = stable_application_key(&identity, None, None, None);
    assert!(!should_skip_session(
        0,
        &None,
        &None,
        &None,
        "WhatsAppDesktop",
        &application_key,
        &identity
    ));
}

#[test]
fn keeps_system_sounds_session_with_stable_key() {
    let display_name = Some("System Sounds".to_string());
    let application_key = stable_application_key(
        &ProcessIdentity::default(),
        None,
        None,
        display_name.as_deref(),
    );

    assert_eq!(application_key.as_deref(), Some("system sounds"));
    assert!(!should_skip_session(
        0,
        &display_name,
        &None,
        &None,
        "System Sounds",
        &application_key,
        &ProcessIdentity::default()
    ));
}

#[test]
fn keeps_webview2_sessions_with_real_display_name() {
    let display_name = Some("WhatsApp".to_string());
    let process_name = Some("msedgewebview2.exe".to_string());
    let process_path = Some(
        "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
            .to_string(),
    );
    let application_key = stable_application_key(
        &ProcessIdentity::default(),
        process_path.as_deref(),
        process_name.as_deref(),
        display_name.as_deref(),
    );

    assert_eq!(application_key.as_deref(), Some("whatsapp"));
    assert!(!should_skip_session(
        14788,
        &display_name,
        &process_name,
        &process_path,
        "WhatsApp",
        &application_key,
        &ProcessIdentity::default()
    ));
}

#[test]
fn skips_nameless_webview2_sessions_without_package_owner() {
    let process_name = Some("msedgewebview2.exe".to_string());
    let process_path = Some(
        "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\148\\msedgewebview2.exe"
            .to_string(),
    );
    let application_key = stable_application_key(
        &ProcessIdentity::default(),
        process_path.as_deref(),
        process_name.as_deref(),
        None,
    );

    assert_eq!(application_key, None);
    assert!(should_skip_session(
        22584,
        &None,
        &process_name,
        &process_path,
        "Msedgewebview2",
        &application_key,
        &ProcessIdentity::default()
    ));
}

#[test]
fn unresolved_resource_display_names_are_preserved() {
    let raw = "@{Missing.Package/Resources/AppTitle}";

    assert_eq!(session_display_name(Some(raw)).as_deref(), Some(raw));
}

#[test]
fn package_icon_scoring_prefers_app_list_logos() {
    let app_logo =
        Path::new("C:\\Apps\\WhatsApp\\Assets\\AppList.targetsize-48_altform-unplated.png");
    let splash = Path::new("C:\\Apps\\WhatsApp\\Assets\\SplashScreen.scale-200.png");
    let badge = Path::new("C:\\Apps\\WhatsApp\\Assets\\BadgeLogo.scale-200.png");

    assert!(package_icon_score(app_logo) > package_icon_score(splash));
    assert!(package_icon_score(app_logo) > package_icon_score(badge));
}

#[test]
fn manifest_icon_paths_prefer_app_list_logo() {
    let manifest = r#"
        <Package>
            <Properties>
                <Logo>Assets\StoreLogo.png</Logo>
            </Properties>
            <Applications>
                <Application Id="App">
                    <uap:VisualElements
                        Square150x150Logo="Assets\MedTile.png"
                        Square44x44Logo="Assets\AppList.png" />
                </Application>
            </Applications>
        </Package>
    "#;

    assert_eq!(
        manifest_icon_base_paths_from_contents(manifest),
        vec!["assets/applist", "assets/storelogo", "assets/medtile"]
    );
}

#[test]
fn package_manifest_display_name_prefers_app_name() {
    let manifest = r#"
        <Package>
            <Properties>
                <DisplayName>WhatsApp</DisplayName>
            </Properties>
            <Applications>
                <Application Id="App">
                    <uap:VisualElements DisplayName="WhatsAppDesktop" />
                </Application>
            </Applications>
        </Package>
    "#;

    assert_eq!(
        package_display_name_from_manifest_contents(manifest).as_deref(),
        Some("WhatsApp")
    );
}

#[test]
fn manifest_logo_matching_accepts_targetsize_variants() {
    let package_path = Path::new("C:\\Program Files\\WindowsApps\\WhatsApp");
    let app_list_icon = package_path.join("Assets\\AppList.targetsize-48_altform-unplated.png");
    let store_icon = package_path.join("Assets\\StoreLogo.scale-200.png");

    assert!(package_icon_matches_manifest_logo(
        &app_list_icon,
        package_path,
        "assets/applist"
    ));
    assert!(!package_icon_matches_manifest_logo(
        &store_icon,
        package_path,
        "assets/applist"
    ));
}
