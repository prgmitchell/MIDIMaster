use super::*;

pub(in crate::audio::windows) fn icon_data_for_path(
    path: &str,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let cache_key = format!("{}|0", path);
    if let Some(cached) = icon_cache.get(&cache_key) {
        return cached.clone();
    }
    let icon_data = extract_icon_data(path, 0);
    icon_cache.insert(cache_key, icon_data.clone());
    icon_data
}

pub(in crate::audio::windows) fn icon_data_for_icon_path(
    icon_path: &str,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let (path, index) = parse_icon_location(icon_path)?;
    let cache_key = format!("{}|{}", path, index);
    if let Some(cached) = icon_cache.get(&cache_key) {
        return cached.clone();
    }
    let icon_data = extract_icon_data(&path, index);
    icon_cache.insert(cache_key, icon_data.clone());
    icon_data
}

pub(in crate::audio::windows) fn icon_data_for_package(
    identity: &ProcessIdentity,
    icon_cache: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let package_full_name = identity.package_full_name.as_deref()?;
    let cache_key = format!("package-icon|{}", package_full_name.to_ascii_lowercase());
    if let Some(cached) = icon_cache.get(&cache_key) {
        return cached.clone();
    }

    let icon_data = package_path_by_full_name(package_full_name)
        .and_then(|path| best_package_icon_path(Path::new(&path)))
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| BASE64_STANDARD.encode(bytes));
    icon_cache.insert(cache_key, icon_data.clone());
    icon_data
}

pub(in crate::audio::windows) fn parse_icon_location(value: &str) -> Option<(String, i32)> {
    let trimmed = value.trim().trim_matches('"').trim_start_matches('@');
    let (path_raw, index) = match trimmed.rsplit_once(',') {
        Some((path, index)) => (path, index.trim().parse::<i32>().ok().unwrap_or(0)),
        None => (trimmed, 0),
    };
    let expanded = expand_known_env_vars(path_raw.trim());
    if expanded.is_empty() {
        None
    } else {
        Some((expanded, index))
    }
}

pub(in crate::audio::windows) fn expand_known_env_vars(value: &str) -> String {
    let mut result = value.to_string();
    if let Ok(system_root) = std::env::var("SystemRoot") {
        result = replace_case_insensitive(&result, "%SystemRoot%", &system_root);
    }
    if let Ok(windir) = std::env::var("WINDIR") {
        result = replace_case_insensitive(&result, "%WINDIR%", &windir);
    }
    result
}

pub(in crate::audio::windows) fn replace_case_insensitive(
    value: &str,
    pattern: &str,
    replacement: &str,
) -> String {
    let mut result = value.to_string();
    let pattern_lower = pattern.to_ascii_lowercase();
    loop {
        let lower = result.to_ascii_lowercase();
        if let Some(index) = lower.find(&pattern_lower) {
            result.replace_range(index..index + pattern.len(), replacement);
        } else {
            break;
        }
    }
    result
}

pub(in crate::audio::windows) fn extract_icon_data(path: &str, index: i32) -> Option<String> {
    let wide_path = to_wide_string(path);
    let mut large = [HICON::default(); 1];
    let mut small = [HICON::default(); 1];
    let count = unsafe {
        ExtractIconExW(
            PCWSTR(wide_path.as_ptr()),
            index,
            Some(large.as_mut_ptr()),
            Some(small.as_mut_ptr()),
            1,
        )
    };
    if count == 0 {
        return None;
    }

    let icon = if !large[0].is_invalid() {
        large[0]
    } else {
        small[0]
    };
    if icon.is_invalid() {
        return None;
    }
    let icon_data = icon_to_png_base64(icon);

    unsafe {
        if !large[0].is_invalid() {
            let _ = DestroyIcon(large[0]);
        }
        if !small[0].is_invalid() {
            let _ = DestroyIcon(small[0]);
        }
    }

    icon_data
}

pub fn extract_executable_icon_base64(path: &str) -> Option<String> {
    extract_icon_data(path, 0)
}

pub(super) fn restore_legacy_icon_alpha(pixels: &mut [u8], mask_pixels: Option<&[u8]>) {
    if pixels.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0) {
        return;
    }

    if let Some(mask) = mask_pixels.filter(|mask| mask.len() >= pixels.len()) {
        for (pixel, mask_pixel) in pixels
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(mask.as_chunks::<4>().0.iter())
        {
            let transparent = mask_pixel[0] != 0 || mask_pixel[1] != 0 || mask_pixel[2] != 0;
            pixel[3] = if transparent { 0 } else { u8::MAX };
        }
        return;
    }

    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel[3] = u8::MAX;
    }
}

pub(in crate::audio::windows) fn icon_to_png_base64(icon: HICON) -> Option<String> {
    let mut icon_info = ICONINFO::default();
    unsafe { GetIconInfo(icon, &mut icon_info).ok()? };

    let bitmap = if !icon_info.hbmColor.is_invalid() {
        icon_info.hbmColor
    } else {
        icon_info.hbmMask
    };
    if bitmap.is_invalid() {
        return None;
    }

    let mut bitmap_data = BITMAP::default();
    let result = unsafe {
        GetObjectW(
            bitmap.into(),
            size_of::<BITMAP>() as i32,
            Some(&mut bitmap_data as *mut _ as *mut _),
        )
    };
    if result == 0 {
        unsafe {
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
        }
        return None;
    }

    let width = bitmap_data.bmWidth;
    let height = bitmap_data.bmHeight;
    if width <= 0 || height <= 0 {
        unsafe {
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
        }
        return None;
    }

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let hdc = unsafe { GetDC(None) };
    if hdc.0.is_null() {
        unsafe {
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
        }
        return None;
    }
    let lines = unsafe {
        GetDIBits(
            hdc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    let mask_pixels = if lines != 0
        && pixels.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 0)
        && !icon_info.hbmColor.is_invalid()
        && !icon_info.hbmMask.is_invalid()
    {
        let mut mask_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut mask = vec![0u8; pixels.len()];
        let mask_lines = unsafe {
            GetDIBits(
                hdc,
                icon_info.hbmMask,
                0,
                height as u32,
                Some(mask.as_mut_ptr() as *mut _),
                &mut mask_info,
                DIB_RGB_COLORS,
            )
        };
        (mask_lines != 0).then_some(mask)
    } else {
        None
    };
    unsafe {
        ReleaseDC(None, hdc);
        let _ = DeleteObject(icon_info.hbmColor.into());
        let _ = DeleteObject(icon_info.hbmMask.into());
    }

    if lines == 0 {
        return None;
    }

    restore_legacy_icon_alpha(&mut pixels, mask_pixels.as_deref());
    for chunk in pixels.as_chunks_mut::<4>().0 {
        chunk.swap(0, 2);
    }

    let mut png_data = Vec::new();
    let encoder = PngEncoder::new(&mut png_data);
    encoder
        .write_image(
            &pixels,
            width as u32,
            height as u32,
            ColorType::Rgba8.into(),
        )
        .ok()?;
    Some(BASE64_STANDARD.encode(png_data))
}
