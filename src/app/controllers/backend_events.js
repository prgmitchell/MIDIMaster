import { performanceAudit } from "../performance_audit_api.js";
import { parseEventPayload } from "../event_payload.js";
import { t } from "../i18n.js";
import { fromOsdSettings } from "../../core/osd_settings.js";
import { applyBindingDeviceMigrations } from "../../core/midi_preferences.js";
import { setBindingTargets, getBindingTargets, getPrimaryBindingTarget } from "../../core/binding_model.js";

/** backend events workflow. */
export function createBackendEvents({
  applyOsdAppearanceAttributes,
  defaultOsdSettings,
  diagnosticError,
  eventSubscriptions,
  features,
  findInlineMuteButton,
  liveState,
  mainScreen,
  midiConnectionStatus,
  midiStatus,
  osdState,
  profileState,
  queueMidiUiEvent,
  queuePerfMidiDispatch,
  queueVolumeUpdatePayload,
  refreshSessions,
  requestBindingsRerender,
  setInlineMuteButtonState,
  showAlert,
  syncButtonValueVisual,
  takePerfMidiDispatch,
  targetsMatch,
  updateFocusedSessionState,
  updateIntegrationStateFromEventPayload,
}) {
  async function setupListeners() {
    if (performanceAudit.enabled) {
      await eventSubscriptions.subscribe("perf_audit_midi_dispatch", (event) => {
        const payload = parseEventPayload(event);
        if (payload && typeof payload === "object") {
          queuePerfMidiDispatch(payload);
        }
      });
    }

    await eventSubscriptions.subscribe("profile_switch_requested", async (event) => {
      if (profileState.switchInFlight) return;
      const payload = parseEventPayload(event);
      const name = String(payload?.name || "").trim();
      if (!name || name === profileState.name) return;

      profileState.switchInFlight = true;
      try {
        await features.profiles?.loadProfileByName?.(name);
        await features.profiles?.refreshProfiles?.(name);
      } catch (error) {
        diagnosticError("binding_profile_switch_failed", error);
        showAlert(
          t("dialogs.profileSwitchUnavailableTitle"),
          t("dialogs.profileSwitchFailedMessage", { name }),
        );
      } finally {
        profileState.switchInFlight = false;
      }
    });

    await eventSubscriptions.subscribe("osd_settings_update", (event) => {
      const payload = parseEventPayload(event);
      if (!payload || typeof payload !== "object") return;
      osdState.settings = fromOsdSettings(payload, { ...defaultOsdSettings, enabled: false });
      document.body.setAttribute("data-anchor", osdState.settings.anchor || "top-right");
      applyOsdAppearanceAttributes(osdState.settings);
    });

    await eventSubscriptions.subscribe("bindings_migrated", (event) => {
      const payload = parseEventPayload(event);
      const count = Number(payload?.count || 0);
      if (!Number.isFinite(count) || count <= 0) {
        return;
      }

      const migrations = Array.isArray(payload?.migrations) ? payload.migrations : [];
      if (migrations.length > 0) {
        const parsedMigrations = migrations
          .map((migration) => {
            const bindingId = String(migration?.bindingId || migration?.binding_id || "");
            const deviceId = String(migration?.deviceId || migration?.device_id || "");
            const previousDeviceId = String(
              migration?.previousDeviceId || migration?.previous_device_id || "",
            );
            if (!bindingId || !deviceId) return null;
            return { bindingId, deviceId, previousDeviceId };
          })
          .filter(Boolean);
        if (parsedMigrations.length === 0) return;

        profileState.bindings = (profileState.bindings || []).map((binding) =>
          applyBindingDeviceMigrations(binding, parsedMigrations),
        );
        requestBindingsRerender("bindings_migrated");
        return;
      }

      const deviceId = payload?.device_id;
      if (!deviceId) {
        return;
      }

      const migrateAuxControl = (control) =>
        control && typeof control === "object" ? { ...control, device_id: deviceId } : control;
      profileState.bindings = (profileState.bindings || []).map((binding) => ({
        ...binding,
        device_id: deviceId,
        mute_control: migrateAuxControl(binding?.mute_control),
        assign_control: migrateAuxControl(binding?.assign_control),
        indicator_control: migrateAuxControl(binding?.indicator_control),
      }));
      requestBindingsRerender("bindings_migrated");
    });

    await eventSubscriptions.subscribe("binding_aux_error", (event) => {
      const payload = parseEventPayload(event);
      if (!payload) return;
      if (payload.reason === "target_list_full") {
        showAlert(t("dialogs.targetListFullTitle"), t("dialogs.targetListFullMessage"));
        return;
      }
      if (payload.reason === "focused_app_unavailable") {
        showAlert(t("dialogs.assignFailedTitle"), t("dialogs.assignFailedMessage"));
      }
    });

    await eventSubscriptions.subscribe("binding_action_error", (event) => {
      const payload = parseEventPayload(event);
      if (!payload || typeof payload !== "object") return;
      const params = payload.params && typeof payload.params === "object" ? payload.params : {};
      const title =
        String(
          payload.title_key ? t(payload.title_key, params) : payload.title || t("dialogs.actionFailedTitle"),
        ).trim() || t("dialogs.actionFailedTitle");
      const message =
        String(
          payload.message_key
            ? t(payload.message_key, params)
            : payload.message || t("dialogs.actionFailedMessage"),
        ).trim() || t("dialogs.actionFailedMessage");
      showAlert(title, message);
    });

    await eventSubscriptions.subscribe("binding_aux_assign_update", (event) => {
      const payload = parseEventPayload(event);
      if (payload?.binding_id) {
        const binding = profileState.bindings.find((b) => b && b.id === payload.binding_id);
        if (binding) {
          if (Array.isArray(payload.targets)) {
            setBindingTargets(binding, payload.targets);
          } else if (payload.target) {
            const nextTargets = getBindingTargets(binding);
            const exists = nextTargets.some(
              (target) => JSON.stringify(target) === JSON.stringify(payload.target),
            );
            if (!exists) {
              nextTargets.push(payload.target);
              setBindingTargets(binding, nextTargets);
            }
          }
        }
      }
      refreshSessions().catch((error) => {
        diagnosticError("aux_assign_refresh_sessions_failed", error);
      });
      requestBindingsRerender("binding_aux_assign_update");
    });

    await eventSubscriptions.subscribe("binding_aux_mute_update", (event) => {
      const payload = parseEventPayload(event);
      if (!payload || !payload.binding_id) return;
      liveState.bindingMuteValues[payload.binding_id] = Boolean(payload.muted);
      const muteButton = findInlineMuteButton(payload.binding_id);
      if (muteButton) {
        setInlineMuteButtonState(muteButton, Boolean(payload.muted));
      }
      const binding = profileState.bindings.find((b) => b && b.id === payload.binding_id);
      if (!binding) return;
      const primaryTarget = getPrimaryBindingTarget(binding);
    });

    await eventSubscriptions.subscribe("midi_event", (event) => {
      if (mainScreen.classList.contains("hidden")) {
        midiStatus.textContent = t("midi.eventStatus", { payload: JSON.stringify(event.payload) });
      }
      const payload = parseEventPayload(event);

      if (!payload || typeof payload !== "object") {
        return;
      }
      const perfDispatch = performanceAudit.enabled ? takePerfMidiDispatch(payload) : null;
      const rendererReceivedAt = performanceAudit.enabled ? performanceAudit.now() : 0;
      queueMidiUiEvent(payload);
      if (perfDispatch && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          const nativeDurationMs = Number(perfDispatch.enqueue_to_dispatch_us || 0) / 1000;
          const rendererDurationMs = performanceAudit.now() - rendererReceivedAt;
          performanceAudit.recordDuration("midi-visible-update", nativeDurationMs + rendererDurationMs, {
            controller: Number(payload.controller),
            msgType: String(payload.msg_type || payload.msgType || "ControlChange"),
          });
        });
      }
    });

    await eventSubscriptions.subscribe("midi_connection_status", (event) => {
      const payload = parseEventPayload(event);
      midiConnectionStatus.handle(payload);
    });

    await eventSubscriptions.subscribe("focused_session_update", (event) => {
      const payload = parseEventPayload(event);
      updateFocusedSessionState(payload);
    });

    await eventSubscriptions.subscribe("mute_update", (event) => {
      const payload = parseEventPayload(event);
      if (!payload) return;
      updateIntegrationStateFromEventPayload(payload);
      if (Object.prototype.hasOwnProperty.call(payload, "focus_session")) {
        updateFocusedSessionState(payload.focus_session);
      }

      if (payload.binding_id != null && typeof payload.muted === "boolean") {
        const buttonInputValue = typeof payload.input_value === "number" ? payload.input_value : null;
        liveState.bindingMuteValues[payload.binding_id] = payload.muted;
        syncButtonValueVisual(payload.binding_id, {
          muted: payload.muted,
          stateValue: payload.muted ? 1 : 0,
          ...(buttonInputValue != null ? { inputValue: buttonInputValue } : {}),
        });
      }

      // Update inline mute buttons.
      // Prefer exact binding-id match first; fall back to target match for mirrored bindings.
      const indexedButtons = features.bindings?.getRenderedBindingEntries?.();
      const buttons = Array.isArray(indexedButtons)
        ? indexedButtons.filter((entry) => entry.muteButton)
        : Array.from(document.querySelectorAll(".binding-mute-button")).map((muteButton) => ({
            muteButton,
            target: null,
          }));
      buttons.forEach(({ muteButton: btn, target: indexedTarget }) => {
        let shouldUpdate = false;
        if (payload.binding_id != null && btn.dataset.bindingId === String(payload.binding_id)) {
          shouldUpdate = true;
        } else {
          try {
            const buttonTarget = indexedTarget ?? JSON.parse(btn.dataset.targetJson || "null");
            shouldUpdate = targetsMatch(buttonTarget, payload.target);
          } catch {
            shouldUpdate = false;
          }
        }
        if (!shouldUpdate) return;
        setInlineMuteButtonState(btn, payload.muted);
      });
    });

    await eventSubscriptions.subscribe("volume_update", (event) => {
      const payload = parseEventPayload(event, {});
      if (!payload || typeof payload !== "object") {
        return;
      }
      queueVolumeUpdatePayload(payload);
    });

    // Plugin host starts after the active profile loads (see startMainApp).
  }

  return { setupListeners };
}
