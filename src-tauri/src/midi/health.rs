use super::*;

impl MidiManager {
    pub fn connection_health(&mut self) -> MidiConnectionHealth {
        self.route_health()
            .into_iter()
            .next()
            .unwrap_or_else(|| MidiConnectionHealth {
                input_device_id: String::new(),
                output_device_id: String::new(),
                connected: false,
                suspect: false,
                reason: String::new(),
                input_suspect: false,
                input_name_mismatch: false,
                expected_input_name: None,
                actual_input_name: None,
                last_input_seen_at: None,
                output_suspect: false,
                output_name_mismatch: false,
                expected_output_name: None,
                actual_output_name: None,
            })
    }

    pub fn route_health(&mut self) -> Vec<MidiConnectionHealth> {
        self.refresh_route_health_state();
        let mut health = self
            .input_routes
            .values()
            .map(|route| {
                let output = self.output_routes.get(&route.output_device_id);
                let expected_input_name =
                    clean_expected_device_name(Some(&route.input_device_name));
                let actual_input_name = expected_input_name
                    .as_ref()
                    .and_then(|_| current_input_port_name(&route.input_device_id).ok());
                let input_name_mismatch = device_name_mismatch(
                    expected_input_name.as_deref(),
                    actual_input_name.as_deref(),
                );
                let input_suspect = route.input_connection_suspect || input_name_mismatch;
                let input_reason = route.input_connection_suspect_reason.clone().or_else(|| {
                    if input_name_mismatch {
                        Some("input_name_mismatch".to_string())
                    } else {
                        None
                    }
                });

                let expected_output_name = output
                    .and_then(|route| clean_expected_device_name(Some(&route.output_device_name)));
                let actual_output_name = expected_output_name
                    .as_ref()
                    .and_then(|_| current_output_port_name(&route.output_device_id).ok());
                let output_name_mismatch = device_name_mismatch(
                    expected_output_name.as_deref(),
                    actual_output_name.as_deref(),
                );
                let output_suspect = output
                    .map(|output| output.connection_suspect)
                    .unwrap_or(true)
                    || output_name_mismatch;
                let output_reason = output
                    .and_then(|output| output.connection_suspect_reason.clone())
                    .or_else(|| {
                        if output_name_mismatch {
                            Some("output_name_mismatch".to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| {
                        if output.is_none() {
                            "output_not_connected".to_string()
                        } else {
                            String::new()
                        }
                    });
                let suspect = input_suspect || output_suspect;
                let reason = input_reason.unwrap_or(output_reason);
                MidiConnectionHealth {
                    input_device_id: route.input_device_id.clone(),
                    output_device_id: route.output_device_id.clone(),
                    connected: route.input_connection.is_some()
                        && !input_suspect
                        && output
                            .map(|output| output.output_connection.is_some() && !output_suspect)
                            .unwrap_or(false),
                    suspect,
                    reason,
                    input_suspect,
                    input_name_mismatch,
                    expected_input_name,
                    actual_input_name,
                    last_input_seen_at: atomic_millis_to_option(&route.last_input_seen_at_ms),
                    output_suspect,
                    output_name_mismatch,
                    expected_output_name,
                    actual_output_name,
                }
            })
            .collect::<Vec<_>>();
        health.sort_by(|a, b| a.input_device_id.cmp(&b.input_device_id));
        health
    }

    pub(super) fn refresh_route_health_state(&mut self) {
        let input_devices = self.list_devices().ok();
        let input_generation = inventory_generation("input");
        let input_device_ids = self.input_routes.keys().cloned().collect::<Vec<_>>();
        for input_device_id in input_device_ids {
            let Some((expected_name, route_generation, has_connection)) =
                self.input_routes.get(&input_device_id).map(|route| {
                    (
                        clean_expected_device_name(Some(&route.input_device_name)),
                        route.input_inventory_generation,
                        route.input_connection.is_some(),
                    )
                })
            else {
                continue;
            };

            if let Some(expected_name) = expected_name.as_deref() {
                let actual_name = input_devices
                    .as_ref()
                    .map(|devices| {
                        inventory_device_name(devices, &input_device_id).map(ToOwned::to_owned)
                    })
                    .unwrap_or_else(|| current_input_port_name(&input_device_id).ok());
                match actual_name {
                    Some(actual_name) if actual_name != expected_name => {
                        log_route_device_mismatch(
                            "input",
                            &input_device_id,
                            expected_name,
                            Some(&actual_name),
                        );
                        self.mark_input_suspect(
                            &input_device_id,
                            "input_name_mismatch",
                            Some(&actual_name),
                        );
                    }
                    Some(_) => {
                        if let Some(route) = self.input_routes.get_mut(&input_device_id) {
                            route.input_inventory_generation = input_generation;
                            if route.input_connection_suspect_reason.as_deref()
                                == Some("input_inventory_changed")
                            {
                                route.input_connection_suspect = false;
                                route.input_connection_suspect_reason = None;
                            }
                        }
                    }
                    None => {
                        log_route_device_mismatch("input", &input_device_id, expected_name, None);
                        self.mark_input_suspect(&input_device_id, "input_port_missing", None);
                    }
                }
            }

            if has_connection && input_generation != route_generation && expected_name.is_none() {
                if let Some(route) = self.input_routes.get_mut(&input_device_id) {
                    route.input_inventory_generation = input_generation;
                }
            }
        }

        let output_device_ids = self.output_routes.keys().cloned().collect::<Vec<_>>();
        for output_device_id in output_device_ids {
            let Some(expected_name) = self.output_expected_name(&output_device_id) else {
                continue;
            };
            match current_output_port_name(&output_device_id) {
                Ok(actual_name) if actual_name != expected_name => {
                    self.mark_output_name_mismatch(
                        &output_device_id,
                        &expected_name,
                        Some(&actual_name),
                    );
                }
                Ok(_) => {}
                Err(_) => {
                    self.mark_output_name_mismatch(&output_device_id, &expected_name, None);
                }
            }
        }
    }

    pub(super) fn mark_output_suspect(&mut self, output_device_id: &str, reason: &str) {
        let Some(route) = self.output_routes.get_mut(output_device_id) else {
            return;
        };
        route.connection_suspect = true;
        route.connection_suspect_reason = Some(reason.to_string());
    }

    pub(super) fn mark_input_suspect(
        &mut self,
        input_device_id: &str,
        reason: &str,
        actual_input_name: Option<&str>,
    ) {
        let Some(route) = self.input_routes.get_mut(input_device_id) else {
            return;
        };
        let should_log = !route.input_connection_suspect
            || route.input_connection_suspect_reason.as_deref() != Some(reason);
        route.input_connection_suspect = true;
        route.input_connection_suspect_reason = Some(reason.to_string());
        if should_log {
            run_logger::warn(
                "midi",
                "input_marked_suspect",
                &format!(
                    "input_device_id={} output_device_id={} expected_input_name={} actual_input_name={} reason={}",
                    route.input_device_id,
                    route.output_device_id,
                    route.input_device_name,
                    actual_input_name.unwrap_or("<unknown>"),
                    reason
                ),
            );
        }
    }

    pub(super) fn clear_output_suspect(route: &mut MidiOutputRoute) {
        route.connection_suspect = false;
        route.connection_suspect_reason = None;
        route.last_reconnect_skipped_log = None;
    }
}
