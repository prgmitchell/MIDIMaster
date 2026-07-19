#[cfg(windows)]
mod platform {
    use crate::windows_display::display_device_id;
    use std::mem::size_of;
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply, SetMonitorBrightness,
        SetVCPFeature, PHYSICAL_MONITOR,
    };
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
    };

    const VCP_BRIGHTNESS: u8 = 0x10;

    struct BrightnessContext {
        value: u32,
        monitor_id: Option<String>,
        matched_displays: usize,
        found: usize,
        updated: usize,
    }

    fn logical_monitor_id(monitor: HMONITOR) -> Option<String> {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() {
            return None;
        }
        let end = info
            .szDevice
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(info.szDevice.len());
        let raw_name = String::from_utf16_lossy(&info.szDevice[..end]);
        display_device_id(&raw_name)
    }

    fn set_physical_brightness(monitor: &PHYSICAL_MONITOR, percentage: u32) -> bool {
        // Prefer the raw MCCS brightness feature. Some displays report success
        // through SetMonitorBrightness but silently ignore the request.
        let mut current = 0;
        let mut maximum = 0;
        let has_vcp_range = unsafe {
            GetVCPFeatureAndVCPFeatureReply(
                monitor.hPhysicalMonitor,
                VCP_BRIGHTNESS,
                None,
                &mut current,
                Some(&mut maximum),
            )
        } != 0;
        let value = if has_vcp_range && maximum > 0 {
            ((percentage as u64 * maximum as u64 + 50) / 100) as u32
        } else {
            percentage
        };
        if unsafe { SetVCPFeature(monitor.hPhysicalMonitor, VCP_BRIGHTNESS, value) } != 0 {
            return true;
        }

        // Keep the Windows high-level API for displays that reject direct VCP
        // writes but expose brightness through the monitor configuration API.
        (unsafe { SetMonitorBrightness(monitor.hPhysicalMonitor, percentage) }) != 0
    }

    unsafe extern "system" fn update_monitor(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> windows_core::BOOL {
        let context = unsafe { &mut *(data.0 as *mut BrightnessContext) };
        if let Some(requested_id) = context.monitor_id.as_deref() {
            let Some(current_id) = logical_monitor_id(monitor) else {
                return windows_core::BOOL(1);
            };
            if !current_id.eq_ignore_ascii_case(requested_id) {
                return windows_core::BOOL(1);
            }
        }
        context.matched_displays += 1;

        let mut count = 0;
        if unsafe { GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, &mut count) }.is_err()
            || count == 0
        {
            return windows_core::BOOL(1);
        }

        let mut physical_monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
        if unsafe { GetPhysicalMonitorsFromHMONITOR(monitor, &mut physical_monitors) }.is_err() {
            return windows_core::BOOL(1);
        }

        context.found += physical_monitors.len();
        for physical in &physical_monitors {
            if set_physical_brightness(physical, context.value) {
                context.updated += 1;
            }
        }
        let _ = unsafe { DestroyPhysicalMonitors(&physical_monitors) };
        windows_core::BOOL(1)
    }

    pub fn set_monitor_brightness(monitor_id: Option<&str>, value: f32) -> Result<(), String> {
        let value = if value.is_finite() { value } else { 0.0 };
        let mut context = BrightnessContext {
            value: (value.clamp(0.0, 1.0) * 100.0).round() as u32,
            monitor_id: monitor_id
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
            matched_displays: 0,
            found: 0,
            updated: 0,
        };

        let enumerated = unsafe {
            EnumDisplayMonitors(
                None,
                None,
                Some(update_monitor),
                LPARAM((&mut context as *mut BrightnessContext) as isize),
            )
        };
        if !enumerated.as_bool() {
            return Err("Failed to enumerate monitors".to_string());
        }
        if context.updated == 0 {
            return Err(
                if context.monitor_id.is_some() && context.matched_displays == 0 {
                    "The selected monitor is no longer connected".to_string()
                } else if context.found == 0 {
                    "No physical monitors were found".to_string()
                } else {
                    "No monitor accepted brightness control; make sure DDC/CI is enabled"
                        .to_string()
                },
            );
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn set_monitor_brightness(_monitor_id: Option<&str>, _value: f32) -> Result<(), String> {
        Err("Monitor brightness control is only available on Windows".to_string())
    }
}

pub(crate) use platform::set_monitor_brightness;

#[cfg(test)]
mod tests {
    #[test]
    fn brightness_values_are_clamped_to_percent() {
        fn percent(value: f32) -> u32 {
            let value = if value.is_finite() { value } else { 0.0 };
            (value.clamp(0.0, 1.0) * 100.0).round() as u32
        }

        assert_eq!(percent(-1.0), 0);
        assert_eq!(percent(0.505), 51);
        assert_eq!(percent(2.0), 100);
        assert_eq!(percent(f32::NAN), 0);
    }
}
