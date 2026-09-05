use super::*;

impl MidiManager {
    pub(super) fn send_resolved_binding_feedback(
        &mut self,
        binding: &Binding,
        send: Option<BindingLightFeedbackSend>,
    ) -> Result<()> {
        let Some(send) = send else {
            return Ok(());
        };
        let binding_context = if send.use_binding_protocol {
            Some(binding)
        } else {
            None
        };
        self.send_feedback_inner(
            &send.device_id,
            send.channel,
            send.controller,
            send.value,
            send.msg_type,
            binding_context,
        )
    }

    pub fn send_binding_feedback(&mut self, binding: &Binding, logical_value: f32) -> Result<()> {
        self.send_resolved_binding_feedback(binding, binding_feedback_send(binding, logical_value))
    }

    pub fn send_binding_feedback_position(
        &mut self,
        binding: &Binding,
        physical_position: f32,
    ) -> Result<()> {
        self.send_resolved_binding_feedback(
            binding,
            binding_feedback_position_send(binding, physical_position),
        )
    }

    pub fn send_binding_light_feedback(&mut self, binding: &Binding, value: f32) -> Result<()> {
        let mut result = Ok(());
        for send in binding_light_feedback_sends(binding, value) {
            let binding_context = if send.use_binding_protocol {
                Some(binding)
            } else {
                None
            };
            if let Err(err) = self.send_feedback_inner(
                &send.device_id,
                send.channel,
                send.controller,
                send.value,
                send.msg_type,
                binding_context,
            ) {
                if result.is_ok() {
                    result = Err(err);
                }
            }
        }
        result
    }

    pub fn send_feedback(
        &mut self,
        device_id: &str,
        channel: u8,
        controller: u8,
        value: f32, // volume or mute state (1.0 = on/muted, 0.0 = off/unmuted)
        msg_type: MidiMessageType,
    ) -> Result<()> {
        self.send_feedback_inner(device_id, channel, controller, value, msg_type, None)
    }

    pub(super) fn send_feedback_inner(
        &mut self,
        device_id: &str,
        channel: u8,
        controller: u8,
        value: f32,
        msg_type: MidiMessageType,
        binding: Option<&Binding>,
    ) -> Result<()> {
        if matches!(msg_type, MidiMessageType::ProgramChange) {
            run_logger::debug(
                "midi",
                "feedback_skipped_program_change",
                &format!(
                    "input_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} normalized_value={:.4}",
                    device_id, channel, controller, msg_type, value
                ),
            );
            return Ok(());
        }

        let resolved_route = self
            .input_routes
            .get(device_id)
            .map(|route| {
                (
                    route.input_device_id.clone(),
                    route.output_device_id.clone(),
                    false,
                )
            })
            .or_else(|| {
                if self.input_routes.len() == 1 {
                    self.input_routes.values().next().map(|route| {
                        (
                            route.input_device_id.clone(),
                            route.output_device_id.clone(),
                            true,
                        )
                    })
                } else {
                    None
                }
            });

        let Some((route_input_device_id, output_device_id, used_single_route_fallback)) =
            resolved_route
        else {
            run_logger::debug(
                "midi",
                "feedback_skipped_no_route",
                &format!(
                    "input_device_id={} active_route_count={} logical_channel={} logical_controller={} logical_msg_type={:?} normalized_value={:.4}",
                    device_id,
                    self.input_routes.len(),
                    channel,
                    controller,
                    msg_type,
                    value
                ),
            );
            return Ok(());
        };
        if used_single_route_fallback {
            run_logger::debug(
                "midi",
                "feedback_route_fallback_single_active",
                &format!(
                    "requested_input_device_id={} route_input_device_id={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} normalized_value={:.4}",
                    device_id,
                    route_input_device_id,
                    output_device_id,
                    channel,
                    controller,
                    msg_type,
                    value
                ),
            );
        }

        let Some(output_device_name) = self
            .output_routes
            .get(&output_device_id)
            .map(|route| route.output_device_name.clone())
        else {
            run_logger::debug(
                "midi",
                "feedback_skipped_no_output",
                &format!(
                    "input_device_id={} requested_input_device_id={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} normalized_value={:.4}",
                    route_input_device_id,
                    device_id,
                    output_device_id,
                    channel,
                    controller,
                    msg_type,
                    value
                ),
            );
            return Ok(());
        };

        let feedback = build_feedback_message(
            channel,
            controller,
            value,
            &msg_type,
            binding,
            &output_device_name,
        );

        let mut send_success = false;
        if let Some(route) = self.output_routes.get_mut(&output_device_id) {
            if route
                .output_connection
                .as_mut()
                .map(|connection| {
                    send_feedback_messages(&feedback.physical_messages, |message| {
                        connection.send(message)
                    })
                    .is_ok()
                })
                .unwrap_or(false)
            {
                send_success = true;
                Self::clear_output_suspect(route);
            }
        }
        if send_success {
            log_feedback_sent_if_needed(
                &route_input_device_id,
                &output_device_id,
                channel,
                controller,
                &msg_type,
                &feedback,
            );
        }

        if !send_success {
            self.mark_output_suspect(&output_device_id, "output_send_failed");
            let (should_attempt, reconnect_failures) = if let Some(route) =
                self.output_routes.get_mut(&output_device_id)
            {
                let should_attempt = route
                    .last_reconnect_attempt
                    .map(|t| t.elapsed() >= OUTPUT_RECONNECT_COOLDOWN)
                    .unwrap_or(true);
                let reconnect_failures = route.reconnect_failures;

                if !should_attempt || reconnect_failures >= MAX_OUTPUT_RECONNECT_FAILURES {
                    if should_log_reconnect_skipped(
                        &mut route.last_reconnect_skipped_log,
                        Instant::now(),
                        OUTPUT_RECONNECT_SKIPPED_LOG_INTERVAL,
                    ) {
                        run_logger::warn(
                                "midi",
                                "output_reconnect_skipped",
                                &format!(
                                    "feedback_protocol={} output_device_id={} output_device_name={} cooldown_ready={} reconnect_failures={} max_failures={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
                                    feedback.protocol,
                                    output_device_id,
                                    output_device_name,
                                    should_attempt,
                                    reconnect_failures,
                                    MAX_OUTPUT_RECONNECT_FAILURES,
                                    channel,
                                    controller,
                                    msg_type,
                                    feedback.physical_channel,
                                    feedback.physical_controller,
                                    feedback.physical_msg_type,
                                    feedback.normalized_value,
                                    feedback.logical_raw_midi_value,
                                    feedback.physical_raw_midi_value,
                                    format_midi_bytes(&feedback.logical_bytes),
                                    format_midi_bytes(&feedback.physical_bytes)
                                ),
                            );
                    }
                    return Ok(());
                }

                route.last_reconnect_attempt = Some(std::time::Instant::now());
                route.last_reconnect_skipped_log = None;
                (should_attempt, reconnect_failures)
            } else {
                return Ok(());
            };
            let _ = should_attempt;
            let _ = reconnect_failures;
            run_logger::warn(
                "midi",
                "output_send_failed",
                &format!(
                    "feedback_protocol={} output_device_id={} output_device_name={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={} action=attempting_reconnect",
                    feedback.protocol,
                    output_device_id,
                    output_device_name,
                    channel,
                    controller,
                    msg_type,
                    feedback.physical_channel,
                    feedback.physical_controller,
                    feedback.physical_msg_type,
                    feedback.normalized_value,
                    feedback.logical_raw_midi_value,
                    feedback.physical_raw_midi_value,
                    format_midi_bytes(&feedback.logical_bytes),
                    format_midi_bytes(&feedback.physical_bytes)
                ),
            );

            if let Some(route) = self.output_routes.get_mut(&output_device_id) {
                route.output_connection = None;
            }
            match self.ensure_output_connected(&output_device_id, Some(&output_device_name)) {
                Ok(_) => {
                    run_logger::info(
                        "midi",
                        "output_reconnected",
                        &format!("output_device_id={}", output_device_id),
                    );
                    if let Some(route) = self.output_routes.get_mut(&output_device_id) {
                        let retry_error = route
                            .output_connection
                            .as_mut()
                            .and_then(|connection| {
                                send_feedback_messages(&feedback.physical_messages, |message| {
                                    connection.send(message)
                                })
                                .err()
                                .map(|error| error.to_string())
                            })
                            .or_else(|| {
                                if route.output_connection.is_none() {
                                    Some("output not connected".to_string())
                                } else {
                                    None
                                }
                            });
                        if let Some(e) = retry_error {
                            route.connection_suspect = true;
                            route.connection_suspect_reason =
                                Some("output_retry_send_failed".to_string());
                            run_logger::error(
                                "midi",
                                "retry_send_failed",
                                &format!(
                                    "feedback_protocol={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={} error={}",
                                    feedback.protocol,
                                    output_device_id,
                                    channel,
                                    controller,
                                    msg_type,
                                    feedback.physical_channel,
                                    feedback.physical_controller,
                                    feedback.physical_msg_type,
                                    feedback.normalized_value,
                                    feedback.logical_raw_midi_value,
                                    feedback.physical_raw_midi_value,
                                    format_midi_bytes(&feedback.logical_bytes),
                                    format_midi_bytes(&feedback.physical_bytes),
                                    e
                                ),
                            );
                        } else {
                            Self::clear_output_suspect(route);
                            run_logger::info(
                                "midi",
                                "retry_send_successful",
                                &format!(
                                    "feedback_protocol={} output_device_id={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} normalized_value={:.4} logical_raw_midi_value={} physical_raw_midi_value={} logical_bytes_hex={} physical_bytes_hex={}",
                                    feedback.protocol,
                                    output_device_id,
                                    channel,
                                    controller,
                                    msg_type,
                                    feedback.physical_channel,
                                    feedback.physical_controller,
                                    feedback.physical_msg_type,
                                    feedback.normalized_value,
                                    feedback.logical_raw_midi_value,
                                    feedback.physical_raw_midi_value,
                                    format_midi_bytes(&feedback.logical_bytes),
                                    format_midi_bytes(&feedback.physical_bytes)
                                ),
                            );
                            log_feedback_sent_if_needed(
                                &route_input_device_id,
                                &output_device_id,
                                channel,
                                controller,
                                &msg_type,
                                &feedback,
                            );
                        }
                    }
                }
                Err(e) => {
                    let failures =
                        if let Some(route) = self.output_routes.get_mut(&output_device_id) {
                            route.connection_suspect = true;
                            route.connection_suspect_reason =
                                Some("output_reconnect_failed".to_string());
                            route.reconnect_failures += 1;
                            route.reconnect_failures
                        } else {
                            self.output_routes.insert(
                                output_device_id.clone(),
                                MidiOutputRoute {
                                    output_connection: None,
                                    output_device_name: output_device_name.clone(),
                                    last_reconnect_attempt: Some(std::time::Instant::now()),
                                    last_reconnect_skipped_log: None,
                                    reconnect_failures: 1,
                                    connection_suspect: true,
                                    connection_suspect_reason: Some(
                                        "output_reconnect_failed".to_string(),
                                    ),
                                },
                            );
                            1
                        };
                    if failures >= MAX_OUTPUT_RECONNECT_FAILURES {
                        run_logger::error(
                            "midi",
                            "output_reconnect_give_up",
                            &format!(
                                "feedback_protocol={} output_device_id={} attempts={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} physical_raw_midi_value={} physical_bytes_hex={} error={}",
                                feedback.protocol,
                                output_device_id,
                                failures,
                                channel,
                                controller,
                                msg_type,
                                feedback.physical_channel,
                                feedback.physical_controller,
                                feedback.physical_msg_type,
                                feedback.physical_raw_midi_value,
                                format_midi_bytes(&feedback.physical_bytes),
                                e
                            ),
                        );
                    } else {
                        run_logger::warn(
                            "midi",
                            "output_reconnect_failed",
                            &format!(
                                "feedback_protocol={} output_device_id={} attempt={} logical_channel={} logical_controller={} logical_msg_type={:?} physical_channel={} physical_controller={} physical_msg_type={:?} physical_raw_midi_value={} physical_bytes_hex={} error={}",
                                feedback.protocol,
                                output_device_id,
                                failures,
                                channel,
                                controller,
                                msg_type,
                                feedback.physical_channel,
                                feedback.physical_controller,
                                feedback.physical_msg_type,
                                feedback.physical_raw_midi_value,
                                format_midi_bytes(&feedback.physical_bytes),
                                e
                            ),
                        );
                    }
                }
            }
        }
        Ok(())
    }
}
