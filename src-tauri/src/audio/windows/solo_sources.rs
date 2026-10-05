use super::*;
use crate::audio::SoloAudioSource;

// Solo includes every playback session, including unnamed sessions that do not
// belong in the target picker. Keep endpoint-qualified IDs for exact restoration.
pub(super) fn list_sources() -> Result<Vec<SoloAudioSource>> {
    let _com = init_com()?;
    let enumerator = get_device_enumerator()?;
    let mut sources = Vec::new();
    let mut icon_cache = HashMap::new();
    for (device, device_id) in enumerate_active_devices(&enumerator, eRender)? {
        // Wave Link's virtual endpoint exposes the same channel identifier as its
        // mixer API. This also works when the user has renamed a channel.
        let interface = get_device_property_string(
            &device,
            &PROPERTYKEY {
                fmtid: GUID::from_u128(0xb3f8fa53_0004_438e_9003_51a46e139bfc),
                pid: 6,
            },
        )
        .unwrap_or_default();
        let wave_link_channel_id = if interface.to_lowercase().contains("elgato virtual audio") {
            get_device_property_string(
                &device,
                &PROPERTYKEY {
                    fmtid: GUID::from_u128(0x233164c8_1b2c_4c7d_bc68_b671687a2567),
                    pid: 1,
                },
            )
            .and_then(|path| path.rsplit('\\').next().map(channel_id_from_path))
        } else {
            None
        };
        visit_audio_sessions::<()>(&device, |control, simple, process_id| {
            let base_id = session_identifier(control, process_id)
                .unwrap_or_else(|| format!("pid:{process_id}"));
            // Qualify even the default endpoint: changing the Windows default
            // while Solo is active must not change the restoration address.
            let id = format!("{device_id}|{base_id}");
            let session = session_info_from_control(
                control,
                simple,
                id.clone(),
                process_id,
                &mut icon_cache,
                false,
            )?
            .unwrap_or(SessionInfo {
                id,
                display_name: "Audio session".into(),
                application_key: None,
                process_name: None,
                process_path: None,
                icon_data: None,
                volume: unsafe { simple.GetMasterVolume() }?,
                is_muted: unsafe { simple.GetMute() }?.as_bool(),
                is_master: false,
            });
            sources.push(SoloAudioSource {
                session,
                device_id: device_id.clone(),
                wave_link_channel_id: wave_link_channel_id.clone(),
            });
            Ok(SessionVisit::Continue)
        })?;
    }
    Ok(sources)
}

fn channel_id_from_path(id: &str) -> String {
    let id = id
        .rsplit_once('_')
        .filter(|(_, suffix)| suffix.chars().all(|c| c.is_ascii_digit()))
        .map(|(prefix, _)| prefix)
        .unwrap_or(id);
    id.to_uppercase()
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "reads live Windows playback sessions and Wave Link endpoint identities"]
    fn live_solo_sources_have_stable_endpoint_addresses() {
        let sources = super::list_sources().unwrap();
        assert!(sources
            .iter()
            .all(|s| s.session.id.starts_with(&format!("{}|", s.device_id))));
        for source in &sources {
            if source.wave_link_channel_id.is_some()
                || source.session.display_name.to_lowercase().contains("wave")
                || source
                    .session
                    .process_name
                    .as_deref()
                    .is_some_and(|name| name.to_lowercase().contains("wave"))
            {
                println!(
                    "Solo route: app={} process={:?} channel={:?}",
                    source.session.display_name,
                    source.session.process_name,
                    source.wave_link_channel_id
                );
            }
        }
        println!(
            "Read {} live playback sessions without changing mute states",
            sources.len()
        );
    }
    #[test]
    fn channel_identifier_is_independent_of_the_endpoint_sample_rate() {
        for sample_rate in ["44100", "48000", "96000"] {
            assert_eq!(
                super::channel_id_from_path(&format!("pcm_out_00_v_06_sd4_{sample_rate}")),
                "PCM_OUT_00_V_06_SD4"
            );
        }
        assert_eq!(
            super::channel_id_from_path("PCM_OUT_00_V_06_SD4"),
            "PCM_OUT_00_V_06_SD4"
        );
    }
}
