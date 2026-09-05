use super::*;

impl MidiManager {
    pub fn set_device_routes(
        &mut self,
        routes: &[MidiDeviceRoute],
        on_event: Arc<dyn Fn(MidiEvent) + Send + Sync + 'static>,
        force_reconnect: bool,
    ) -> Result<()> {
        let mut next_routes = Vec::new();
        let mut seen_inputs = std::collections::HashSet::new();
        for route in routes {
            let Some(route) = route.normalized() else {
                continue;
            };
            if !route.enabled {
                continue;
            }
            let input_device_id = route.input_id().unwrap_or_default().to_string();
            let output_device_id = route.output_id().unwrap_or_default().to_string();
            if !seen_inputs.insert(input_device_id.clone()) {
                return Err(anyhow!("Duplicate MIDI input route: {}", input_device_id));
            }
            next_routes.push(PreparedMidiRoute {
                input_device_id,
                output_device_id,
                input_device_name: clean_expected_device_name(route.input_device_name.as_deref()),
                output_device_name: clean_expected_device_name(route.output_device_name.as_deref()),
            });
        }

        preflight_midi_routes(&next_routes)?;

        let desired_inputs = next_routes
            .iter()
            .map(|route| route.input_device_id.clone())
            .collect::<std::collections::HashSet<_>>();

        for route in &next_routes {
            if force_reconnect {
                self.force_output_reconnect(&route.output_device_id);
            }
            self.ensure_output_connected(
                &route.output_device_id,
                route.output_device_name.as_deref(),
            )?;
        }

        let input_inventory_generation = inventory_generation("input");
        for route in next_routes {
            let expected_input_device_name = route.input_device_name.clone().or_else(|| {
                self.input_routes
                    .get(&route.input_device_id)
                    .and_then(|existing| {
                        clean_expected_device_name(Some(&existing.input_device_name))
                    })
            });
            let needs_reconnect = if let Some(existing) =
                self.input_routes.get_mut(&route.input_device_id)
            {
                if let Some(expected_name) = expected_input_device_name.as_deref() {
                    existing.input_device_name = expected_name.to_string();
                }
                if existing.output_device_id != route.output_device_id {
                    run_logger::info(
                        "midi",
                        "input_route_output_changed",
                        &format!(
                            "input_device_id={} previous_output={} next_output={}",
                            route.input_device_id,
                            existing.output_device_id,
                            route.output_device_id
                        ),
                    );
                    existing.output_device_id = route.output_device_id.clone();
                }
                if input_inventory_generation != existing.input_inventory_generation {
                    existing.input_inventory_generation = input_inventory_generation;
                    if existing.input_connection_suspect_reason.as_deref()
                        == Some("input_inventory_changed")
                    {
                        existing.input_connection_suspect = false;
                        existing.input_connection_suspect_reason = None;
                    }
                    run_logger::info(
                        "midi",
                        "input_inventory_revalidated",
                        &format!(
                            "input_device_id={} output_device_id={} expected_input_name={} current_generation={}",
                            existing.input_device_id,
                            existing.output_device_id,
                            existing.input_device_name,
                            input_inventory_generation
                        ),
                    );
                }
                force_reconnect
                    || existing.input_connection.is_none()
                    || existing.input_connection_suspect
            } else {
                true
            };
            if !needs_reconnect {
                continue;
            }

            let reconnecting = self.input_routes.remove(&route.input_device_id).is_some();
            if reconnecting {
                run_logger::warn(
                    "midi",
                    "input_reconnect_attempt",
                    &format!(
                        "input_device_id={} output_device_id={} expected_input_name={}",
                        route.input_device_id,
                        route.output_device_id,
                        expected_input_device_name.as_deref().unwrap_or("")
                    ),
                );
            }
            let input_route = match self.connect_input_route(
                &route.input_device_id,
                &route.output_device_id,
                expected_input_device_name.as_deref(),
                on_event.clone(),
            ) {
                Ok(route) => route,
                Err(err) => {
                    run_logger::error(
                        "midi",
                        "input_reconnect_failed",
                        &format!(
                            "input_device_id={} output_device_id={} expected_input_name={} error={}",
                            route.input_device_id,
                            route.output_device_id,
                            expected_input_device_name.as_deref().unwrap_or(""),
                            err
                        ),
                    );
                    return Err(err);
                }
            };
            self.input_routes
                .insert(route.input_device_id.clone(), input_route);
            if reconnecting {
                run_logger::info(
                    "midi",
                    "input_reconnected",
                    &format!(
                        "input_device_id={} output_device_id={} expected_input_name={}",
                        route.input_device_id,
                        route.output_device_id,
                        expected_input_device_name.as_deref().unwrap_or("")
                    ),
                );
            }
        }

        // Keep previous routes alive until every replacement that can be connected has
        // succeeded. This makes a failed editor Apply non-destructive for old routes.
        let existing_inputs = self.input_routes.keys().cloned().collect::<Vec<_>>();
        for input_device_id in existing_inputs {
            if !desired_inputs.contains(&input_device_id) {
                self.input_routes.remove(&input_device_id);
                run_logger::info(
                    "midi",
                    "input_route_disconnected",
                    &format!("input_device_id={}", input_device_id),
                );
            }
        }

        let referenced_outputs = self
            .input_routes
            .values()
            .map(|route| route.output_device_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let existing_outputs = self.output_routes.keys().cloned().collect::<Vec<_>>();
        for output_device_id in existing_outputs {
            if !referenced_outputs.contains(&output_device_id) {
                self.output_routes.remove(&output_device_id);
                run_logger::info(
                    "midi",
                    "output_route_disconnected",
                    &format!("output_device_id={}", output_device_id),
                );
            }
        }

        Ok(())
    }

    pub(super) fn connect_input_route(
        &self,
        input_device_id: &str,
        output_device_id: &str,
        expected_input_device_name: Option<&str>,
        on_event: Arc<dyn Fn(MidiEvent) + Send + Sync + 'static>,
    ) -> Result<MidiInputRoute> {
        let mut midi_in = MidiInput::new("MIDIMaster")?;
        midi_in.ignore(Ignore::None);
        let (input_port, input_port_name) =
            resolve_input_port(&midi_in, input_device_id, expected_input_device_name)?;
        run_logger::info(
            "midi",
            "start_route_requested",
            &format!(
                "input_device_id={} output_device_id={}",
                input_device_id, output_device_id
            ),
        );

        let event_device_id = input_device_id.to_string();
        let last_input_seen_at_ms = Arc::new(AtomicU64::new(0));
        let callback_last_input_seen_at_ms = Arc::clone(&last_input_seen_at_ms);

        let connection = midi_in.connect(
            &input_port,
            "midimaster-input",
            move |_timestamp, message, _| {
                callback_last_input_seen_at_ms.store(now_epoch_millis(), Ordering::Relaxed);
                if LOG_MIDI_MESSAGES {
                    run_logger::debug("midi", "raw_message", &format!("bytes={:?}", message));
                }
                if let Some(event) = parse_midi_message(&event_device_id, message) {
                    log_midi_input_if_needed(&event, message);
                    on_event(event);
                }
            },
            (),
        )?;

        run_logger::info(
            "midi",
            "input_connected",
            &format!(
                "input_device_id={} input_device_name={} output_device_id={}",
                input_device_id, input_port_name, output_device_id
            ),
        );

        Ok(MidiInputRoute {
            input_connection: Some(connection),
            input_device_id: input_device_id.to_string(),
            input_device_name: input_port_name,
            output_device_id: output_device_id.to_string(),
            input_connection_suspect: false,
            input_connection_suspect_reason: None,
            input_inventory_generation: inventory_generation("input"),
            last_input_seen_at_ms,
        })
    }

    pub fn stop(&mut self) {
        run_logger::info(
            "midi",
            "stop_device",
            &format!(
                "input_route_count={} output_route_count={}",
                self.input_routes.len(),
                self.output_routes.len()
            ),
        );
        self.input_routes.clear();
        self.output_routes.clear();
    }

    pub fn stop_route(&mut self, input_device_id: &str) -> Option<String> {
        let route = self.input_routes.remove(input_device_id)?;
        let output_device_id = route.output_device_id.clone();
        let still_referenced = self
            .input_routes
            .values()
            .any(|other| other.output_device_id == output_device_id);
        if !still_referenced {
            self.output_routes.remove(&output_device_id);
        }
        run_logger::info(
            "midi",
            "route_stopped",
            &format!(
                "input_device_id={} output_device_id={}",
                input_device_id, output_device_id
            ),
        );
        Some(output_device_id)
    }
}
