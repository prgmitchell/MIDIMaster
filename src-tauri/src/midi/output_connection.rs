use super::*;

impl MidiManager {
    pub(super) fn open_output_connection(
        output_device_id: &str,
        expected_output_device_name: Option<&str>,
    ) -> Result<(MidiOutputConnection, String)> {
        let midi_out = MidiOutput::new("MIDIMaster")?;
        let (output_port, output_port_name) =
            resolve_output_port(&midi_out, output_device_id, expected_output_device_name)?;
        let output_connection = midi_out
            .connect(&output_port, "midimaster-output")
            .map_err(|e| anyhow!("Failed to connect to output: {}", e))?;
        Ok((output_connection, output_port_name))
    }

    pub(super) fn ensure_output_connected(
        &mut self,
        output_device_id: &str,
        expected_output_device_name: Option<&str>,
    ) -> Result<()> {
        let expected_output_device_name = clean_expected_device_name(expected_output_device_name)
            .or_else(|| {
                self.output_routes
                    .get(output_device_id)
                    .and_then(|route| clean_expected_device_name(Some(&route.output_device_name)))
            });
        if let Some(route) = self.output_routes.get_mut(output_device_id) {
            if route.output_connection.is_some() && !route.connection_suspect {
                if let Some(expected_name) = expected_output_device_name.as_deref() {
                    match current_output_port_name(output_device_id) {
                        Ok(actual_name) => {
                            if actual_name != expected_name {
                                log_route_device_mismatch(
                                    "output",
                                    output_device_id,
                                    expected_name,
                                    Some(&actual_name),
                                );
                                route.connection_suspect = true;
                                route.connection_suspect_reason =
                                    Some("output_name_mismatch".to_string());
                                return Err(anyhow!(
                                    "MIDI output device id {} now resolves to '{}' instead of '{}'",
                                    output_device_id,
                                    actual_name,
                                    expected_name
                                ));
                            }
                            route.output_device_name = actual_name;
                        }
                        Err(err) => {
                            log_route_device_mismatch(
                                "output",
                                output_device_id,
                                expected_name,
                                None,
                            );
                            route.connection_suspect = true;
                            route.connection_suspect_reason =
                                Some("output_port_missing".to_string());
                            return Err(err);
                        }
                    }
                }
                Self::clear_output_suspect(route);
                route.reconnect_failures = 0;
                return Ok(());
            }
        }
        // Release a failed handle before opening the same Windows MIDI port again.
        self.force_output_reconnect(output_device_id);
        let (output_connection, output_port_name) =
            Self::open_output_connection(output_device_id, expected_output_device_name.as_deref())?;
        if let Some(expected_name) = expected_output_device_name.as_deref() {
            if output_port_name != expected_name {
                log_route_device_mismatch(
                    "output",
                    output_device_id,
                    expected_name,
                    Some(&output_port_name),
                );
                return Err(anyhow!(
                    "MIDI output device id {} now resolves to '{}' instead of '{}'",
                    output_device_id,
                    output_port_name,
                    expected_name
                ));
            }
        }
        match self.output_routes.get_mut(output_device_id) {
            Some(route) => {
                route.output_connection = Some(output_connection);
                route.output_device_name = output_port_name.clone();
                route.reconnect_failures = 0;
                Self::clear_output_suspect(route);
            }
            None => {
                self.output_routes.insert(
                    output_device_id.to_string(),
                    MidiOutputRoute {
                        output_connection: Some(output_connection),
                        output_device_name: output_port_name.clone(),
                        last_reconnect_attempt: None,
                        last_reconnect_skipped_log: None,
                        reconnect_failures: 0,
                        connection_suspect: false,
                        connection_suspect_reason: None,
                    },
                );
            }
        }
        run_logger::info(
            "midi",
            "output_connected",
            &format!(
                "output_device_id={} output_device_name={}",
                output_device_id, output_port_name
            ),
        );
        Ok(())
    }

    pub(super) fn force_output_reconnect(&mut self, output_device_id: &str) {
        if let Some(route) = self.output_routes.get_mut(output_device_id) {
            route.output_connection = None;
            route.last_reconnect_skipped_log = None;
        }
    }

    pub(super) fn output_expected_name(&self, output_device_id: &str) -> Option<String> {
        self.output_routes
            .get(output_device_id)
            .and_then(|route| clean_expected_device_name(Some(&route.output_device_name)))
    }

    pub(super) fn mark_output_name_mismatch(
        &mut self,
        output_device_id: &str,
        expected_name: &str,
        actual_name: Option<&str>,
    ) {
        log_route_device_mismatch("output", output_device_id, expected_name, actual_name);
        if let Some(route) = self.output_routes.get_mut(output_device_id) {
            route.connection_suspect = true;
            route.connection_suspect_reason = Some(
                if actual_name.is_some() {
                    "output_name_mismatch"
                } else {
                    "output_port_missing"
                }
                .to_string(),
            );
        }
    }
}
