// Declarative markup: kept intact to preserve DOM hierarchy and CSS selectors.
export const bindingsTemplate = `<div id="binding-config-panel" class="target-panel hidden">
    <div class="target-panel-content binding-config-content">
      <div class="target-panel-header">
        <button id="binding-config-back" type="button" class="target-panel-back binding-config-back hidden" aria-label="Back" data-i18n-aria-label="common.back">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <span id="binding-config-title" data-i18n="bindings.faderConfiguration">Fader Configuration</span>
        <button id="binding-config-close" type="button" class="target-panel-close">x</button>
      </div>
      <div class="binding-config-body">
        <div class="binding-config-layout">
          <div class="binding-config-main-column">
            <section class="binding-config-section binding-config-section--name">
              <label class="binding-config-stack">
                <span class="binding-config-title" data-i18n="common.name">Name</span>
                <input id="binding-config-name" type="text" placeholder="Binding name" name="binding-config-name" autocomplete="new-password" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-i18n-placeholder="bindings.bindingNamePlaceholder" />
              </label>
            </section>

            <section id="binding-config-button-light-section" class="binding-config-section binding-config-section--button-light hidden">
              <div class="binding-config-title-row">
                <span class="binding-config-title" data-i18n="bindings.light">Light</span>
              </div>
              <label class="binding-config-select-row" id="binding-config-button-light-select-row">
                <span class="binding-config-toggle-copy">
                  <span class="binding-config-toggle-title" data-i18n="bindings.toggleMuteLight">Button light</span>
                  <span class="binding-config-toggle-help" data-i18n="bindings.toggleMuteLightHelp">Choose when the button light turns on.</span>
                </span>
                <select id="binding-config-button-light-select" class="binding-config-light-select" aria-label="Button light" data-i18n-aria-label="bindings.toggleMuteLight">
                  <option value="Disabled" data-i18n="bindings.feedbackDisabled">Disabled</option>
                  <option value="MappedWhenAssigned" data-i18n="bindings.buttonLightWhenMapped">When Mapped</option>
                  <option value="FollowState" data-i18n="bindings.buttonLightWhenOn">When On</option>
                  <option value="InvertState" data-i18n="bindings.buttonLightWhenOff">When Off</option>
                  <option value="Pressed" data-i18n="bindings.buttonLightWhilePressed">While Pressed</option>
                </select>
              </label>
              <div id="binding-config-indicator-custom" class="binding-config-indicator-custom">
                <div class="binding-config-indicator-heading">
                  <span class="binding-config-toggle-title" data-i18n="bindings.indicatorOutput">Indicator output</span>
                  <span class="binding-config-toggle-help" data-i18n="bindings.indicatorOutputHelp">MIDI address that receives LED feedback.</span>
                </div>
                <label class="binding-config-indicator-field">
                  <span data-i18n="bindings.indicatorType">Type</span>
                  <select id="binding-config-indicator-msg-type" class="binding-config-light-select" aria-label="Indicator message type" data-i18n-aria-label="bindings.indicatorMessageType">
                    <option value="Note">Note</option>
                    <option value="ControlChange">CC</option>
                  </select>
                </label>
                <label class="binding-config-indicator-field">
                  <span data-i18n="bindings.indicatorChannel">Channel</span>
                  <input id="binding-config-indicator-channel" type="number" min="1" max="16" step="1" inputmode="numeric" aria-label="Indicator channel" data-i18n-aria-label="bindings.indicatorChannelLabel" />
                </label>
                <label class="binding-config-indicator-field">
                  <span data-i18n="bindings.indicatorControl">Control</span>
                  <input id="binding-config-indicator-controller" type="number" min="0" max="127" step="1" inputmode="numeric" aria-label="Indicator control" data-i18n-aria-label="bindings.indicatorControlLabel" />
                </label>
                <div class="binding-config-indicator-actions">
                  <button id="binding-config-indicator-learn" type="button" class="binding-config-button binding-config-button--primary binding-config-icon-button" aria-label="Learn indicator output" title="Learn indicator output" data-i18n-aria-label="bindings.learnIndicatorOutput" data-i18n-title="bindings.learnIndicatorOutput">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <circle cx="12" cy="12" r="7"></circle>
                      <circle cx="12" cy="12" r="2.5"></circle>
                      <path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
                    </svg>
                  </button>
                  <button id="binding-config-indicator-clear" type="button" class="binding-config-button binding-config-button--secondary binding-config-icon-button" aria-label="Reset indicator output" title="Reset indicator output" data-i18n-aria-label="bindings.resetIndicatorOutput" data-i18n-title="bindings.resetIndicatorOutput">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M4 7v5h5"></path>
                      <path d="M5.5 12A7 7 0 1 0 8 6.7L4 10.5"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </section>

            <section id="binding-config-macro-summary-section" class="binding-config-section binding-config-section--macro-summary hidden">
              <div class="binding-config-title-row">
                <span class="binding-config-title" data-i18n="macro.title">Macro</span>
                <div class="binding-config-title-actions">
                  <button id="binding-config-macro-edit" type="button" class="binding-config-button binding-config-button--primary" data-i18n="macro.edit">Edit Macro</button>
                </div>
              </div>
              <div id="binding-config-macro-summary" class="binding-config-macro-summary"></div>
            </section>

            <section id="binding-config-macro-section" class="binding-config-section binding-config-section--macro hidden">
              <div class="binding-config-title-row">
                <span class="binding-config-title" data-i18n="macro.title">Macro</span>
                <div class="binding-config-title-actions">
                  <button id="binding-config-macro-add-action" type="button" class="binding-config-button binding-config-button--secondary" data-i18n="macro.step.action">Action</button>
                  <button id="binding-config-macro-add-wait" type="button" class="binding-config-button binding-config-button--secondary" data-i18n="macro.step.wait">Wait</button>
                  <button id="binding-config-macro-add-parallel" type="button" class="binding-config-button binding-config-button--secondary" data-i18n="macro.step.parallelGroup">Parallel</button>
                </div>
              </div>
              <div id="binding-config-macro-list" class="binding-config-macro-list"></div>
            </section>

            <section id="binding-config-soundboard-section" class="binding-config-section binding-config-section--soundboard hidden">
              <div class="soundboard-file-row">
                <div class="soundboard-file-copy">
                  <span class="binding-config-toggle-title" data-i18n="soundboard.audioFile">Audio file</span>
                  <span id="binding-config-soundboard-file" class="soundboard-file-name"></span>
                  <span id="binding-config-soundboard-status" class="soundboard-file-status" role="status" aria-live="polite"></span>
                </div>
                <div class="soundboard-transport">
                  <button id="binding-config-soundboard-preview" type="button" class="soundboard-transport-button" data-state="stopped" aria-label="Play preview" data-i18n-aria-label="soundboard.previewPlay">
                    <svg class="soundboard-transport-icon soundboard-transport-icon--play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>
                    <svg class="soundboard-transport-icon soundboard-transport-icon--pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"></path></svg>
                  </button>
                  <span id="binding-config-soundboard-playback-time" class="soundboard-playback-time">0:00.000</span>
                </div>
                <button id="binding-config-soundboard-replace" type="button" class="binding-config-button binding-config-button--secondary" data-i18n="soundboard.pickSound">Pick Sound</button>
              </div>
              <div class="soundboard-waveform-shell">
                <canvas id="binding-config-soundboard-waveform" class="soundboard-waveform" width="1024" height="240" tabindex="0" aria-label="Sound waveform with draggable trim handles" data-i18n-aria-label="soundboard.waveformLabel"></canvas>
                <div class="soundboard-waveform-empty" aria-hidden="true">
                  <svg viewBox="0 0 64 32" aria-hidden="true">
                    <path d="M3 16h5m4-7v14m6-19v24m6-17v10m6-15v20m6-11v2m6-9v16m6-5v10m6-13v6m5-6h2"></path>
                  </svg>
                  <strong data-i18n="soundboard.noFile">No audio file selected</strong>
                </div>
              </div>
              <div class="soundboard-time-row" aria-live="polite">
                <span><span data-i18n="soundboard.start">Start</span> <strong id="binding-config-soundboard-start-time">0:00.000</strong></span>
                <span><span data-i18n="soundboard.selection">Selection</span> <strong id="binding-config-soundboard-selection-time">0:00.000</strong></span>
                <span><span data-i18n="soundboard.end">End</span> <strong id="binding-config-soundboard-end-time">0:00.000</strong></span>
              </div>
              <div class="soundboard-accessible-controls">
                <label>
                  <span data-i18n="soundboard.startHandle">Trim start</span>
                  <input id="binding-config-soundboard-start" type="range" min="0" max="0" step="10" value="0" />
                </label>
                <label>
                  <span data-i18n="soundboard.endHandle">Trim end</span>
                  <input id="binding-config-soundboard-end" type="range" min="0" max="0" step="10" value="0" />
                </label>
              </div>
              <div class="soundboard-options-grid">
                <fieldset class="soundboard-routing-row">
                  <legend data-i18n="soundboard.routing">Send sound to</legend>
                  <label class="soundboard-route-option">
                    <span>
                      <strong data-i18n="soundboard.monitor">Monitor</strong>
                      <small data-i18n="soundboard.monitorHelp">Play through the selected output device.</small>
                    </span>
                    <span class="settings-toggle"><input id="binding-config-soundboard-monitor" type="checkbox" checked /><span class="plugins-toggle-ui" aria-hidden="true"></span></span>
                  </label>
                  <label id="binding-config-soundboard-virtual-mic-option" class="soundboard-route-option is-unavailable">
                    <span>
                      <strong data-i18n="soundboard.virtualMicrophone">Virtual microphone</strong>
                      <small id="binding-config-soundboard-virtual-mic-help" data-i18n="virtualAudio.checking">Checking Virtual Audio…</small>
                    </span>
                    <span class="settings-toggle"><input id="binding-config-soundboard-virtual-mic" type="checkbox" aria-describedby="binding-config-soundboard-virtual-mic-help" disabled /><span class="plugins-toggle-ui" aria-hidden="true"></span></span>
                  </label>
                </fieldset>
                <div class="soundboard-output-row">
                  <span id="binding-config-soundboard-output-label" data-i18n="soundboard.outputDevice">Output device</span>
                  <select id="binding-config-soundboard-output" aria-labelledby="binding-config-soundboard-output-label"></select>
                </div>
                <label class="soundboard-slider-row">
                  <span data-i18n="soundboard.speed">Speed</span>
                  <input id="binding-config-soundboard-speed" type="range" min="50" max="200" step="5" value="100" />
                  <strong id="binding-config-soundboard-speed-value">1.00×</strong>
                </label>
                <label class="soundboard-slider-row">
                  <span data-i18n="soundboard.volume">Sound volume</span>
                  <input id="binding-config-soundboard-volume" type="range" min="0" max="100" step="1" value="100" />
                  <strong id="binding-config-soundboard-volume-value">100%</strong>
                </label>
              </div>
            </section>

            <section id="binding-config-curve-section" class="binding-config-section binding-config-section--curve">
              <div class="binding-config-title-row">
                <span class="binding-config-title" data-i18n="bindings.curve">Curve</span>
              </div>
              <div class="binding-config-curve-toolbar">
                <span class="binding-config-curve-toolbar-label" data-i18n="bindings.presets">Presets</span>
                <div id="binding-config-curve-preset-root" class="binding-config-curve-preset-root">
                  <button
                    id="binding-config-curve-preset-button"
                    type="button"
                    class="binding-config-curve-preset-button"
                    aria-haspopup="listbox"
                    aria-expanded="false"
                  >Linear</button>
                  <div id="binding-config-curve-preset-menu" class="binding-config-curve-preset-menu hidden">
                    <label class="binding-config-curve-preset-search">
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />
                      </svg>
                      <input id="binding-config-curve-preset-search" type="search" placeholder="Search presets..." autocomplete="off" data-i18n-placeholder="bindings.curvePresetSearchPlaceholder" />
                    </label>
                    <div id="binding-config-curve-preset-list" class="binding-config-curve-preset-list" role="listbox" aria-label="Curve presets" data-i18n-aria-label="bindings.curvePresetOptions"></div>
                  </div>
                </div>
                <button id="binding-config-curve-preset-save" type="button" class="binding-config-button binding-config-button--primary" data-i18n="bindings.saveCurrentCurve">Save Current</button>
                <button id="binding-config-custom-reset" type="button" class="binding-config-button binding-config-button--secondary" data-i18n="common.reset">Reset</button>
              </div>
              <div id="binding-config-curve-preset-form" class="binding-config-curve-preset-dialog hidden" role="dialog" aria-modal="true" aria-labelledby="binding-config-curve-preset-form-title">
                <div class="binding-config-curve-preset-dialog-card">
                  <span id="binding-config-curve-preset-form-title" class="binding-config-curve-preset-form-title" data-i18n="bindings.curvePresetSaveTitle">Save Curve Preset</span>
                  <input id="binding-config-curve-preset-name" type="text" maxlength="64" placeholder="Preset name" autocomplete="off" spellcheck="false" data-i18n-placeholder="bindings.curvePresetNamePlaceholder" />
                  <div class="binding-config-curve-preset-dialog-actions">
                    <button id="binding-config-curve-preset-form-cancel" type="button" class="binding-config-button binding-config-button--secondary" data-i18n="common.cancel">Cancel</button>
                    <button id="binding-config-curve-preset-form-save" type="button" class="binding-config-button binding-config-button--primary" data-i18n="common.save">Save</button>
                  </div>
                </div>
              </div>
              <div id="binding-config-curve-cards" class="binding-config-curve-cards" role="listbox" aria-label="Fader curve options" data-i18n-aria-label="bindings.curveOptions"></div>
              <p id="binding-config-curve-help" class="binding-config-curve-help" data-i18n="bindings.linearHelp">Linear response. Output value changes at the same rate as the fader movement.</p>
            </section>

            <section id="binding-config-feedback-output-section" class="binding-config-section binding-config-section--feedback-output hidden">
              <div id="binding-config-feedback-output-custom" class="binding-config-indicator-custom binding-config-feedback-output-custom">
                <div class="binding-config-indicator-heading">
                  <span class="binding-config-toggle-title" data-i18n="bindings.feedbackOutput">Feedback output</span>
                  <span class="binding-config-toggle-help" data-i18n="bindings.feedbackOutputHelp">Note, CC, or Pitch Bend address that receives fader feedback.</span>
                </div>
                <label class="binding-config-indicator-field">
                  <span data-i18n="bindings.indicatorType">Type</span>
                  <select id="binding-config-feedback-msg-type" class="binding-config-light-select" aria-label="Feedback message type" data-i18n-aria-label="bindings.feedbackMessageType">
                    <option value="Disabled" data-i18n="bindings.feedbackDisabled">Disabled</option>
                    <option value="Note">Note</option>
                    <option value="ControlChange">CC</option>
                    <option value="PitchBend" data-i18n="bindings.pitchBend">Pitch Bend</option>
                  </select>
                </label>
                <label class="binding-config-indicator-field">
                  <span data-i18n="bindings.indicatorChannel">Channel</span>
                  <input id="binding-config-feedback-channel" type="number" min="1" max="16" step="1" inputmode="numeric" aria-label="Feedback channel" data-i18n-aria-label="bindings.feedbackChannelLabel" />
                </label>
                <label class="binding-config-indicator-field">
                  <span data-i18n="bindings.indicatorControl">Control</span>
                  <input id="binding-config-feedback-controller" type="number" min="0" max="127" step="1" inputmode="numeric" aria-label="Feedback control" data-i18n-aria-label="bindings.feedbackControlLabel" />
                </label>
                <div class="binding-config-indicator-actions">
                  <button id="binding-config-feedback-learn" type="button" class="binding-config-button binding-config-button--primary binding-config-icon-button" aria-label="Learn feedback output" title="Learn feedback output" data-i18n-aria-label="bindings.learnFeedbackOutput" data-i18n-title="bindings.learnFeedbackOutput">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <circle cx="12" cy="12" r="7"></circle>
                      <circle cx="12" cy="12" r="2.5"></circle>
                      <path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
                    </svg>
                  </button>
                  <button id="binding-config-feedback-clear" type="button" class="binding-config-button binding-config-button--secondary binding-config-icon-button" aria-label="Reset feedback output" title="Reset feedback output" data-i18n-aria-label="bindings.resetFeedbackOutput" data-i18n-title="bindings.resetFeedbackOutput">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M4 7v5h5"></path>
                      <path d="M5.5 12A7 7 0 1 0 8 6.7L4 10.5"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </section>

            <section id="binding-config-mute-section" class="binding-config-section binding-config-section--mute">
              <span class="binding-config-title binding-config-title-with-action">
                <span data-i18n="bindings.mute">Mute</span>
                <div id="binding-config-mute-mode-root" class="binding-config-mode-root">
                  <button
                    id="binding-config-mute-mode-button"
                    type="button"
                    class="binding-config-mode-trigger"
                    title="Mute behavior: Toggle on press"
                    aria-label="Mute behavior"
                    data-i18n-title="bindings.muteBehaviorToggle"
                    data-i18n-aria-label="bindings.muteBehavior"
                    aria-haspopup="true"
                    aria-expanded="false"
                  >
                    <svg class="binding-config-mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"></path>
                    </svg>
                  </button>
                  <div id="binding-config-mute-mode-menu" class="binding-config-mode-menu hidden" role="menu" aria-label="Mute behavior options" data-i18n-aria-label="bindings.muteBehaviorOptions">
                    <button id="binding-config-mute-mode-toggle" type="button" class="binding-config-mode-option" data-mode="ToggleOnPress" role="menuitem" data-i18n="bindings.toggle">Toggle</button>
                    <button id="binding-config-mute-mode-value" type="button" class="binding-config-mode-option" data-mode="SetFromValue" role="menuitem" data-i18n="common.match">Match</button>
                  </div>
                </div>
              </span>
              <div class="binding-config-actions">
                <span id="binding-config-mute-label" class="binding-config-label" data-i18n="bindings.notMapped">Not mapped</span>
                <button id="binding-config-mute-learn" type="button" class="binding-config-button binding-config-button--primary binding-config-icon-button" aria-label="Learn" title="Learn" data-i18n-aria-label="common.learn" data-i18n-title="common.learn">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <circle cx="12" cy="12" r="7"></circle>
                    <circle cx="12" cy="12" r="2.5"></circle>
                    <path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
                  </svg>
                </button>
                <button id="binding-config-mute-clear" type="button" class="binding-config-button binding-config-button--secondary binding-config-icon-button" aria-label="Clear" title="Clear" data-i18n-aria-label="common.clear" data-i18n-title="common.clear">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M6 6l12 12M18 6 6 18"></path>
                  </svg>
                </button>
              </div>
            </section>

            <section id="binding-config-assign-section" class="binding-config-section binding-config-section--assign">
              <span class="binding-config-title binding-config-title-with-action">
                <span data-i18n="common.assign">Assign</span>
                <div id="binding-config-assign-mode-root" class="binding-config-mode-root">
                  <button
                    id="binding-config-assign-mode-button"
                    type="button"
                    class="binding-config-mode-trigger"
                    title="Assign mode: Add"
                    aria-label="Assign mode"
                    data-i18n-title="bindings.assignModeAdd"
                    data-i18n-aria-label="bindings.assignMode"
                    aria-haspopup="true"
                    aria-expanded="false"
                  >
                    <svg class="binding-config-mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 0 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"></path>
                    </svg>
                  </button>
                  <div id="binding-config-assign-mode-menu" class="binding-config-mode-menu hidden" role="menu" aria-label="Assign mode options" data-i18n-aria-label="bindings.assignModeOptions">
                    <button id="binding-config-assign-mode-add" type="button" class="binding-config-mode-option" data-mode="Add" role="menuitem" data-i18n="common.add">Add</button>
                    <button id="binding-config-assign-mode-replace" type="button" class="binding-config-mode-option" data-mode="Replace" role="menuitem" data-i18n="bindings.replace">Replace</button>
                    <button id="binding-config-assign-mode-clear" type="button" class="binding-config-mode-option" data-mode="Clear" role="menuitem" data-i18n="common.clear">Clear</button>
                  </div>
                </div>
              </span>
              <div class="binding-config-actions">
                <span id="binding-config-assign-label" class="binding-config-label" data-i18n="bindings.notMapped">Not mapped</span>
                <button id="binding-config-assign-learn" type="button" class="binding-config-button binding-config-button--primary binding-config-icon-button" aria-label="Learn" title="Learn" data-i18n-aria-label="common.learn" data-i18n-title="common.learn">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <circle cx="12" cy="12" r="7"></circle>
                    <circle cx="12" cy="12" r="2.5"></circle>
                    <path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
                  </svg>
                </button>
                <button id="binding-config-assign-clear" type="button" class="binding-config-button binding-config-button--secondary binding-config-icon-button" aria-label="Clear" title="Clear" data-i18n-aria-label="common.clear" data-i18n-title="common.clear">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M6 6l12 12M18 6 6 18"></path>
                  </svg>
                </button>
              </div>
            </section>
          </div>

          <aside class="binding-config-preview-column">
            <section class="binding-config-preview-shell">
              <div class="binding-config-preview-card">
                <div class="binding-config-title-row">
                  <span class="binding-config-title" data-i18n="bindings.live">Live</span>
                </div>
                <div class="binding-config-preview-stage">
                  <div class="binding-config-preview-stage-title binding-config-title" data-i18n="bindings.live">Live</div>
                  <div class="binding-config-preview-target">
                    <div id="binding-config-preview-target-icon" class="binding-config-preview-target-icon" aria-hidden="true"></div>
                    <div class="binding-config-preview-target-copy">
                      <div id="binding-config-preview-target-label" class="binding-config-preview-target-label" data-i18n="common.target">Target</div>
                      <div id="binding-config-preview-target-tags" class="binding-config-preview-target-tags"></div>
                    </div>
                  </div>
                  <div class="binding-config-preview-fader">
                    <div class="binding-config-preview-scale">
                      <span>100</span>
                      <span>75</span>
                      <span>50</span>
                      <span>25</span>
                      <span>0</span>
                    </div>
                    <div class="binding-config-preview-track">
                      <div id="binding-config-preview-fill" class="binding-config-preview-fill"></div>
                      <div id="binding-config-preview-thumb" class="binding-config-preview-thumb"></div>
                    </div>
                  </div>
                  <div id="binding-config-preview-button" class="binding-config-preview-button hidden" aria-hidden="true">
                    <div id="binding-config-preview-button-face" class="binding-config-preview-button-face">
                      <span id="binding-config-preview-button-label" class="binding-config-preview-button-label" data-i18n="bindings.button">Button</span>
                    </div>
                  </div>
                </div>
                <div class="binding-config-preview-meta">
                  <div class="binding-config-preview-value-block">
                    <div id="binding-config-preview-value" class="binding-config-preview-value">0%</div>
                    <div id="binding-config-preview-status" class="binding-config-preview-status" data-i18n="bindings.waitingForLiveInput">Waiting for live input</div>
                  </div>
                  <div class="binding-config-preview-summary binding-config-preview-summary--midi">
                    <div class="binding-config-preview-summary-row">
                      <span class="binding-config-preview-summary-label" data-i18n="bindings.mainMidi">Main MIDI</span>
                      <span id="binding-config-preview-main-midi" class="binding-config-preview-summary-value" data-i18n="bindings.notMapped">Not mapped</span>
                    </div>
                    <div class="binding-config-preview-summary-row">
                      <span class="binding-config-preview-summary-label" data-i18n="common.value">Value</span>
                      <span id="binding-config-preview-midi-value" class="binding-config-preview-summary-value">0 / 127</span>
                    </div>
                  </div>
                  <section id="binding-config-button-learn-section" class="binding-config-section binding-config-section--button-learn hidden">
                    <div class="binding-config-title-row">
                      <span class="binding-config-title" data-i18n="common.learn">Learn</span>
                    </div>
                    <div class="binding-config-preview-learn-row">
                      <button id="binding-config-button-learn-button" type="button" class="binding-config-button binding-config-button--primary" data-i18n="bindings.learnButton">Learn Button</button>
                      <div id="binding-config-button-learn-indicator" class="binding-config-preview-learn-indicator hidden" aria-live="polite">
                        <div class="learn-panel-spinner" aria-hidden="true"></div>
                        <span id="binding-config-button-learn-status" data-i18n="bindings.waitingMidiInput">Waiting for MIDI input...</span>
                      </div>
                    </div>
                  </section>
                  <div class="binding-config-preview-summary binding-config-preview-summary--status">
                    <div id="binding-config-preview-mute-row" class="binding-config-preview-summary-row">
                      <span class="binding-config-preview-summary-label" data-i18n="bindings.mute">Mute</span>
                      <span id="binding-config-preview-mute" class="binding-config-preview-summary-value" data-i18n="bindings.notMapped">Not mapped</span>
                    </div>
                    <div id="binding-config-preview-assign-row" class="binding-config-preview-summary-row">
                      <span class="binding-config-preview-summary-label" data-i18n="common.assign">Assign</span>
                      <span id="binding-config-preview-assign" class="binding-config-preview-summary-value" data-i18n="bindings.notMapped">Not mapped</span>
                    </div>
                    <div id="binding-config-preview-curve-row" class="binding-config-preview-summary-row">
                      <span class="binding-config-preview-summary-label" data-i18n="bindings.curve">Curve</span>
                      <span id="binding-config-preview-curve" class="binding-config-preview-summary-value" data-i18n="bindings.linear">Linear</span>
                    </div>
                  </div>
                </div>
              </div>
              <div id="binding-config-preview-learn-shell" class="binding-config-preview-learn-shell">
                <div class="binding-config-title-row">
                  <span class="binding-config-title" data-i18n="common.learn">Learn</span>
                </div>
                <div class="binding-config-preview-learn-row">
                  <button id="binding-config-preview-learn-button" type="button" class="binding-config-button binding-config-button--primary" data-i18n="bindings.learnFader">Learn Fader</button>
                  <div id="binding-config-preview-learn-indicator" class="binding-config-preview-learn-indicator hidden" aria-live="polite">
                    <div class="learn-panel-spinner" aria-hidden="true"></div>
                    <span id="binding-config-preview-learn-status" data-i18n="bindings.waitingMidiInput">Waiting for MIDI input...</span>
                  </div>
                </div>
              </div>
            </section>
          </aside>
        </div>

        <div class="binding-config-footer">
          <button id="binding-config-cancel" type="button" class="binding-config-button binding-config-button--secondary" data-i18n="common.cancel">Cancel</button>
          <button id="binding-config-save" type="button" class="binding-config-button binding-config-button--primary" data-i18n="common.save">Save</button>
        </div>
      </div>
    </div>
  </div>`;
