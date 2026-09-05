// Declarative markup: kept intact to preserve DOM hierarchy and CSS selectors.
export const settingsTemplate = `<section id="settings-panel" class="app-page hidden" data-page-panel="settings">
          <div class="settings-panel-body">
            <div class="settings-shell">
              <aside class="settings-sidebar" aria-label="Settings sections" data-i18n-aria-label="settings.sections">
                <div class="settings-nav-indicator" aria-hidden="true"></div>
                <nav class="settings-nav">
                  <button class="settings-nav-item active" type="button" data-settings-section="startup" aria-current="page">
                    <span class="settings-nav-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M6 4v16"></path>
                        <path d="M12 4v16"></path>
                        <path d="M18 4v16"></path>
                        <path d="M4 8h4"></path>
                        <path d="M10 15h4"></path>
                        <path d="M16 11h4"></path>
                      </svg>
                    </span>
                    <span class="settings-nav-label" data-i18n="settings.general">General</span>
                  </button>
                  <button class="settings-nav-item" type="button" data-settings-section="osd">
                    <span class="settings-nav-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M4 6h16v11H4z"></path>
                        <path d="M9 20h6"></path>
                        <path d="M12 17v3"></path>
                      </svg>
                    </span>
                    <span class="settings-nav-label" data-i18n="settings.osd">On-Screen Display</span>
                  </button>
                  <button class="settings-nav-item" type="button" data-settings-section="appearance">
                    <span class="settings-nav-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M12 3v2"></path>
                        <path d="M12 19v2"></path>
                        <path d="M3 12h2"></path>
                        <path d="M19 12h2"></path>
                        <path d="m5.65 5.65 1.4 1.4"></path>
                        <path d="m16.95 16.95 1.4 1.4"></path>
                        <path d="m18.35 5.65-1.4 1.4"></path>
                        <path d="m7.05 16.95-1.4 1.4"></path>
                        <path d="M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z"></path>
                      </svg>
                    </span>
                    <span class="settings-nav-label" data-i18n="settings.appearance">Appearance</span>
                  </button>
                  <button class="settings-nav-item" type="button" data-settings-section="virtual-audio">
                    <span class="settings-nav-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M5 9v6"></path>
                        <path d="M9 6v12"></path>
                        <path d="M13 4v16"></path>
                        <path d="M17 7v10"></path>
                        <path d="M21 10v4"></path>
                      </svg>
                    </span>
                    <span class="settings-nav-label" data-i18n="virtualAudio.title">Virtual Audio</span>
                  </button>
                  <button class="settings-nav-item" type="button" data-settings-section="maintenance">
                    <span class="settings-nav-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4.8 16.2a2.1 2.1 0 0 0 3 3l4.5-4.5a4 4 0 0 0 5.4-5.4"></path>
                        <path d="m14 7 3 3"></path>
                      </svg>
                    </span>
                    <span class="settings-nav-label" data-i18n="settings.maintenance">Maintenance</span>
                  </button>
                </nav>
              </aside>

              <div class="settings-content">
                <section class="settings-section settings-section-panel settings-general-section active" data-settings-panel="startup">
                  <div class="settings-card settings-startup-card">
                    <div class="settings-card-section-heading">
                      <span class="settings-card-section-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                          <path d="M5 12a7 7 0 1 0 14 0 7 7 0 0 0-14 0Z"></path>
                          <path d="M12 7v5l3 2"></path>
                        </svg>
                      </span>
                      <span data-i18n="settings.behavior">Behavior</span>
                    </div>
                    <div class="settings-startup-row settings-language-row">
                      <div class="settings-startup-row-main">
                        <span class="settings-startup-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M4 5h16"></path>
                            <path d="M8 5c.75 4.5 3.25 8 8 10"></path>
                            <path d="M16 5c-.75 4.5-3.25 8-8 10"></path>
                            <path d="M5 19h6"></path>
                            <path d="m8 15-3 4"></path>
                            <path d="m8 15 3 4"></path>
                            <path d="M13 19h6"></path>
                          </svg>
                        </span>
                        <div class="settings-field-label" data-i18n="settings.language">Language</div>
                      </div>
                      <select id="language-select" title="Language" data-i18n-title="settings.language"></select>
                    </div>
                    <div class="settings-startup-row">
                      <div class="settings-startup-row-main">
                        <span class="settings-startup-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M12 3v7"></path>
                            <path d="M7.05 6.35a8 8 0 1 0 9.9 0"></path>
                          </svg>
                        </span>
                        <div class="settings-field-label" data-i18n="settings.startWithWindows">Start with Windows</div>
                      </div>
                      <label class="settings-toggle" title="Start with Windows" data-i18n-title="settings.startWithWindows">
                        <input id="start-with-windows" type="checkbox" />
                        <span class="plugins-toggle-ui" aria-hidden="true"></span>
                      </label>
                    </div>
                    <div class="settings-startup-row">
                      <div class="settings-startup-row-main">
                        <span class="settings-startup-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M12 4v9"></path>
                            <path d="m8.5 9.5 3.5 3.5 3.5-3.5"></path>
                            <path d="M5 16h14l-1.5 4h-11L5 16Z"></path>
                          </svg>
                        </span>
                        <div class="settings-field-label" data-i18n="settings.startInTray">Start in tray</div>
                      </div>
                      <label class="settings-toggle" title="Start in tray" data-i18n-title="settings.startInTray">
                        <input id="start-in-tray" type="checkbox" />
                        <span class="plugins-toggle-ui" aria-hidden="true"></span>
                      </label>
                    </div>
                    <div class="settings-startup-row">
                      <div class="settings-startup-row-main">
                        <span class="settings-startup-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M5 6h14"></path>
                            <path d="M9 11h6"></path>
                            <path d="M12 13v5"></path>
                            <path d="m9 16 3 3 3-3"></path>
                          </svg>
                        </span>
                        <div class="settings-field-label" data-i18n="settings.minimizeToTray">Minimize to tray</div>
                      </div>
                      <label class="settings-toggle" title="Minimize to tray" data-i18n-title="settings.minimizeToTray">
                        <input id="minimize-to-tray" type="checkbox" />
                        <span class="plugins-toggle-ui" aria-hidden="true"></span>
                      </label>
                    </div>
                    <div class="settings-startup-row">
                      <div class="settings-startup-row-main">
                        <span class="settings-startup-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M14 7h4v10h-4"></path>
                            <path d="M10 9 7 12l3 3"></path>
                            <path d="M7 12h9"></path>
                          </svg>
                        </span>
                        <div class="settings-field-label" data-i18n="settings.exitToTray">Exit to tray</div>
                      </div>
                      <label class="settings-toggle" title="Exit to tray" data-i18n-title="settings.exitToTray">
                        <input id="exit-to-tray" type="checkbox" />
                        <span class="plugins-toggle-ui" aria-hidden="true"></span>
                      </label>
                    </div>
                  </div>

                  <div class="settings-card settings-update-card">
                    <div class="settings-card-section-heading">
                      <span class="settings-card-section-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                          <path d="M20 5v5h-5"></path>
                          <path d="M4 19v-5h5"></path>
                          <path d="M6.75 9A7 7 0 0 1 18 6.5L20 10"></path>
                          <path d="M17.25 15A7 7 0 0 1 6 17.5L4 14"></path>
                        </svg>
                      </span>
                      <span data-i18n="settings.updates">Updates</span>
                    </div>
                    <div class="settings-startup-row settings-update-toggle-row">
                      <div class="settings-startup-row-main">
                        <span class="settings-startup-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M12 5v4l2.5 2.5"></path>
                            <path d="M20 12a8 8 0 1 1-2.35-5.65"></path>
                            <path d="M20 4v5h-5"></path>
                          </svg>
                        </span>
                        <div class="settings-field-label" data-i18n="settings.autoCheckUpdates">Automatically check for updates</div>
                      </div>
                      <label class="settings-toggle" title="Automatically check for updates" data-i18n-title="settings.autoCheckUpdates">
                        <input id="auto-check-updates-button" type="checkbox" />
                        <span class="plugins-toggle-ui" aria-hidden="true"></span>
                      </label>
                    </div>
                    <div class="settings-update-summary">
                      <div id="settings-update-status" class="settings-inline-status">
                        <span class="settings-status-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" focusable="false">
                            <path d="M5 12.5 9.25 16.75 19 7"></path>
                          </svg>
                        </span>
                        <span class="settings-status-text" data-i18n="settings.noUpdateCheckYet">No update check yet.</span>
                      </div>
                      <div class="settings-update-versions">
                        <span><span data-i18n="common.current">Current</span> <strong id="update-current-version">-</strong></span>
                        <span><span data-i18n="common.latest">Latest</span> <strong id="update-latest-version">-</strong></span>
                      </div>
                    </div>
                    <button id="check-for-updates" type="button" class="settings-action">
                      <span class="settings-button-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                          <path d="M20 5v5h-5"></path>
                          <path d="M4 19v-5h5"></path>
                          <path d="M6.75 9A7 7 0 0 1 18 6.5L20 10"></path>
                          <path d="M17.25 15A7 7 0 0 1 6 17.5L4 14"></path>
                        </svg>
                      </span>
                      <span class="settings-button-label" data-i18n="settings.checkForUpdates">Check for updates</span>
                    </button>
                  </div>
                </section>

                <section id="virtual-audio-panel" class="settings-section settings-section-panel virtual-audio-section" data-settings-panel="virtual-audio" data-virtual-audio-state="loading">
                  <div class="settings-card virtual-audio-progress-card" data-virtual-audio-view="loading" role="status" aria-live="polite">
                    <span class="virtual-audio-spinner" aria-hidden="true"></span>
                    <div>
                      <h3 data-i18n="virtualAudio.checking">Checking Virtual Audio…</h3>
                    </div>
                  </div>

                  <div class="settings-card virtual-audio-setup-card hidden" data-virtual-audio-view="not-installed">
                    <div class="virtual-audio-setup-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path></svg>
                    </div>
                    <div class="virtual-audio-setup-copy">
                      <h3 data-i18n="virtualAudio.setupTitle">Set up your virtual microphone</h3>
                      <p data-i18n="virtualAudio.setupDescription">This installs the signed USBIP system driver and MIDIMaster audio service. USB devices may briefly reconnect and Windows may require a restart.</p>
                    </div>
                    <button id="virtual-audio-install" class="settings-action virtual-audio-primary-action" type="button">
                      <span class="settings-button-label" data-i18n="virtualAudio.install">Install Virtual Audio</span>
                    </button>
                  </div>

                  <div class="settings-card virtual-audio-progress-card hidden" data-virtual-audio-view="installing" role="status" aria-live="polite">
                    <span class="virtual-audio-spinner" aria-hidden="true"></span>
                    <div>
                      <h3 data-i18n="virtualAudio.installing">Setting up Virtual Audio…</h3>
                      <p data-i18n="virtualAudio.installingDescription">Approve the Windows prompt if it appears. MIDIMaster will finish setup automatically.</p>
                    </div>
                  </div>

                  <div class="settings-card virtual-audio-restart-card hidden" data-virtual-audio-view="restart-required">
                    <div>
                      <h3 data-i18n="virtualAudio.restartTitle">Restart required</h3>
                      <p data-i18n="virtualAudio.restartDescription">Windows needs to restart before the virtual microphone is ready.</p>
                    </div>
                    <div class="virtual-audio-button-row">
                      <button id="virtual-audio-restart" class="settings-action virtual-audio-primary-action" type="button"><span class="settings-button-label" data-i18n="virtualAudio.restartNow">Restart Now</span></button>
                      <button id="virtual-audio-restart-later" class="settings-action" type="button"><span class="settings-button-label" data-i18n="virtualAudio.later">Later</span></button>
                    </div>
                  </div>

                  <div class="virtual-audio-ready-layout hidden" data-virtual-audio-view="ready">
                    <div class="settings-card virtual-audio-routing-card">
                      <div class="settings-card-section-heading settings-card-section-heading--inline">
                        <span data-i18n="virtualAudio.routing">Routing</span>
                        <label class="settings-toggle" title="Enable virtual microphone routing" data-i18n-title="virtualAudio.enableRouting">
                          <input id="virtual-audio-enabled" type="checkbox" />
                          <span class="plugins-toggle-ui" aria-hidden="true"></span>
                        </label>
                      </div>
                      <p id="virtual-audio-routing-error" class="virtual-audio-routing-error hidden" role="alert"></p>
                      <div class="virtual-audio-control-row virtual-audio-control-row--select">
                        <span class="virtual-audio-control-copy">
                          <strong data-i18n="virtualAudio.microphone">Microphone</strong>
                          <small data-i18n="virtualAudio.microphoneHelp">Choose the microphone mixed with soundboard clips.</small>
                        </span>
                        <select id="virtual-audio-input-device" aria-label="Microphone" data-i18n-aria-label="virtualAudio.microphone"></select>
                      </div>
                      <label class="virtual-audio-control-row">
                        <span class="virtual-audio-control-copy"><strong data-i18n="virtualAudio.microphoneGain">Microphone gain</strong></span>
                        <span class="settings-range-control">
                          <input id="virtual-audio-microphone-gain" class="binding-volume-slider" type="range" min="-24" max="24" step="1" value="0" />
                          <span id="virtual-audio-microphone-gain-value" class="settings-range-value">0 dB</span>
                        </span>
                      </label>
                      <label class="virtual-audio-control-row">
                        <span class="virtual-audio-control-copy"><strong data-i18n="virtualAudio.soundboardGain">Soundboard gain</strong></span>
                        <span class="settings-range-control">
                          <input id="virtual-audio-soundboard-gain" class="binding-volume-slider" type="range" min="-24" max="12" step="1" value="-6" />
                          <span id="virtual-audio-soundboard-gain-value" class="settings-range-value">-6 dB</span>
                        </span>
                      </label>
                    </div>

                    <div class="settings-card virtual-audio-meters-card">
                      <div class="settings-card-section-heading settings-card-section-heading--inline"><span data-i18n="virtualAudio.levels">Levels</span></div>
                      <div class="virtual-audio-meter-grid">
                        <div class="virtual-audio-meter-row"><span data-i18n="virtualAudio.microphone">Microphone</span><div id="virtual-audio-microphone-meter" class="virtual-audio-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></div>
                        <div class="virtual-audio-meter-row"><span data-i18n="soundboard.title">Soundboard</span><div id="virtual-audio-soundboard-meter" class="virtual-audio-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></div>
                        <div class="virtual-audio-meter-row"><span data-i18n="virtualAudio.finalOutput">Final output</span><div id="virtual-audio-output-meter" class="virtual-audio-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></div>
                        <div class="virtual-audio-meter-row"><span><span data-i18n="virtualAudio.limiter">Limiter</span> <strong id="virtual-audio-limiter-value">0.0 dB</strong></span><div id="virtual-audio-limiter-meter" class="virtual-audio-meter virtual-audio-meter--limiter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div></div>
                      </div>
                    </div>

                    <div class="settings-card virtual-audio-health-card">
                      <div class="settings-card-section-heading settings-card-section-heading--inline">
                        <span data-i18n="virtualAudio.componentHealth">Component health</span>
                      </div>
                      <div id="virtual-audio-update-notice" class="virtual-audio-update-notice hidden" role="status">
                        <span class="virtual-audio-update-copy">
                          <strong data-i18n="virtualAudio.updateAvailable">Virtual Audio update available</strong>
                          <small data-i18n="virtualAudio.updateDescription">Install the Virtual Audio service included with this version of MIDIMaster.</small>
                        </span>
                        <button id="virtual-audio-update" class="settings-action virtual-audio-primary-action" type="button"><span class="settings-button-label" data-i18n="virtualAudio.update">Update Virtual Audio</span></button>
                      </div>
                      <dl class="virtual-audio-health-grid">
                        <div><dt data-i18n="virtualAudio.driverVersion">USBIP driver</dt><dd id="virtual-audio-driver-version">—</dd></div>
                        <div><dt data-i18n="virtualAudio.service">Audio service</dt><dd id="virtual-audio-service-status">—</dd></div>
                        <div><dt data-i18n="virtualAudio.endpoint">Virtual microphone</dt><dd id="virtual-audio-endpoint-status">—</dd></div>
                      </dl>
                      <p class="settings-field-help virtual-audio-remove-help" data-i18n="virtualAudio.removeHelp">Removing Virtual Audio removes the MIDIMaster device and service. The shared USBIP driver stays installed.</p>
                      <div class="virtual-audio-button-row">
                        <button id="virtual-audio-repair" class="settings-action" type="button"><span class="settings-button-label" data-i18n="virtualAudio.repair">Repair Virtual Audio</span></button>
                        <button id="virtual-audio-remove" class="settings-action virtual-audio-danger-action" type="button"><span class="settings-button-label" data-i18n="virtualAudio.remove">Remove Virtual Audio</span></button>
                      </div>
                    </div>
                  </div>

                  <div class="settings-card virtual-audio-problem-card hidden" data-virtual-audio-view="problem">
                    <div class="virtual-audio-problem-copy">
                      <h3 data-i18n="virtualAudio.problemTitle">Virtual Audio needs attention</h3>
                      <p id="virtual-audio-problem-message" role="alert"></p>
                    </div>
                    <div class="virtual-audio-button-row">
                      <button id="virtual-audio-copy-diagnostics" class="settings-action" type="button"><span class="settings-button-label" data-i18n="virtualAudio.copyDiagnostics">Copy Diagnostics</span></button>
                      <button id="virtual-audio-problem-repair" class="settings-action" type="button"><span class="settings-button-label" data-i18n="virtualAudio.repair">Repair Virtual Audio</span></button>
                    </div>
                  </div>
                </section>

                <section class="settings-section settings-section-panel settings-osd-section" data-settings-panel="osd">
                  <div class="settings-card">
                    <div class="settings-field-row settings-field-row--monitor">
                      <div class="settings-field-label" data-i18n="settings.general">General</div>
                      <div class="settings-monitor-control">
                        <div class="settings-osd-enabled-control">
                          <span class="settings-inline-label" data-i18n="settings.enabled">Enabled</span>
                          <label class="settings-toggle" title="Toggle on-screen display" data-i18n-title="settings.toggleOsd">
                            <input id="osd-enabled" type="checkbox" checked />
                            <span class="plugins-toggle-ui" aria-hidden="true"></span>
                          </label>
                        </div>
                        <div class="settings-osd-monitor-select-control">
                          <span class="settings-inline-label" data-i18n="settings.monitor">Monitor</span>
                          <select id="osd-monitor"></select>
                        </div>
                        <div class="settings-osd-label-control">
                          <span class="settings-inline-label" data-i18n="settings.osdLabel">Displayed name</span>
                          <select id="osd-label-mode" title="Displayed name" data-i18n-title="settings.osdLabel">
                            <option value="target" data-i18n="settings.osdLabelTarget">Target name</option>
                            <option value="binding" data-i18n="settings.osdLabelBinding">Binding name</option>
                          </select>
                        </div>
                      </div>
                    </div>
                    <div class="settings-field-row settings-field-row--appearance">
                      <div class="settings-field-label" data-i18n="settings.appearance">Appearance</div>
                      <div class="settings-appearance-grid">
                        <div class="settings-appearance-control">
                          <span data-i18n="settings.style">Style</span>
                          <select id="osd-style">
                            <option value="midnight" data-i18n="settings.styleDark">Dark</option>
                            <option value="glass" data-i18n="settings.styleGlass">Glass</option>
                            <option value="neon" data-i18n="settings.styleNeon">Neon</option>
                            <option value="studio" data-i18n="settings.styleStudio">Studio</option>
                          </select>
                          <div class="osd-style-segments" aria-label="OSD style" data-i18n-aria-label="settings.osdStyle">
                            <button type="button" class="osd-style-segment" data-osd-style-option="midnight" data-i18n="settings.styleDark">Dark</button>
                            <button type="button" class="osd-style-segment" data-osd-style-option="glass" data-i18n="settings.styleGlass">Glass</button>
                            <button type="button" class="osd-style-segment" data-osd-style-option="neon" data-i18n="settings.styleNeon">Neon</button>
                            <button type="button" class="osd-style-segment" data-osd-style-option="studio" data-i18n="settings.styleStudio">Studio</button>
                          </div>
                        </div>
                        <div class="settings-appearance-control">
                          <span data-i18n="settings.transparency">Transparency</span>
                          <div class="settings-range-control">
                            <input id="osd-transparency" class="binding-volume-slider" type="range" min="35" max="100" step="1" value="96" />
                            <span id="osd-transparency-value" class="settings-range-value">96%</span>
                          </div>
                        </div>
                        <div class="settings-appearance-control">
                          <span data-i18n="settings.size">Size</span>
                          <div class="settings-range-control">
                            <input id="osd-scale" class="binding-volume-slider" type="range" min="75" max="150" step="5" value="100" />
                            <span id="osd-scale-value" class="settings-range-value">100%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="settings-field-row settings-field-row--position">
                      <div class="settings-field-label" data-i18n="settings.position">Position</div>
                      <div class="settings-position-layout" id="osd-position-picker" data-anchor="top-right">
                        <div class="settings-osd-preview">
                          <div class="settings-osd-preview-screen">
                            <button type="button" class="osd-position-dot" data-anchor="top-left" aria-label="Top left" data-i18n-aria-label="settings.positionTopLeft"></button>
                            <button type="button" class="osd-position-dot" data-anchor="top-center" aria-label="Top center" data-i18n-aria-label="settings.positionTopCenter"></button>
                            <button type="button" class="osd-position-dot selected" data-anchor="top-right" aria-label="Top right" data-i18n-aria-label="settings.positionTopRight"></button>
                            <button type="button" class="osd-position-dot" data-anchor="center-left" aria-label="Center left" data-i18n-aria-label="settings.positionCenterLeft"></button>
                            <button type="button" class="osd-position-dot" data-anchor="center" aria-label="Center" data-i18n-aria-label="settings.positionCenter"></button>
                            <button type="button" class="osd-position-dot" data-anchor="center-right" aria-label="Center right" data-i18n-aria-label="settings.positionCenterRight"></button>
                            <button type="button" class="osd-position-dot" data-anchor="bottom-left" aria-label="Bottom left" data-i18n-aria-label="settings.positionBottomLeft"></button>
                            <button type="button" class="osd-position-dot" data-anchor="bottom-center" aria-label="Bottom center" data-i18n-aria-label="settings.positionBottomCenter"></button>
                            <button type="button" class="osd-position-dot" data-anchor="bottom-right" aria-label="Bottom right" data-i18n-aria-label="settings.positionBottomRight"></button>
                            <div class="settings-osd-preview-card">
                              <div class="settings-osd-preview-header">
                                <div class="settings-osd-preview-icon"></div>
                                <div class="settings-osd-preview-label">MIDIMaster</div>
                                <div class="settings-osd-preview-value">100%</div>
                              </div>
                              <div class="settings-osd-preview-bar">
                                <div class="settings-osd-preview-fill"></div>
                              </div>
                            </div>
                          </div>
                          <div class="settings-osd-preview-stand"></div>
                        </div>
                        <div class="settings-field-help" data-i18n="settings.osdPositionHelp">The on-screen display will appear in the selected area of your screen.</div>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="settings-section settings-section-panel settings-appearance-section" data-settings-panel="appearance">
                  <div class="settings-appearance-card">
                    <div class="appearance-preset-preview-row">
                      <div class="appearance-preset-column">
                        <div class="settings-card-section-heading settings-card-section-heading--inline">
                          <span data-i18n="settings.appearance.themePresets">Theme Presets</span>
                        </div>
                        <div id="appearance-presets" class="appearance-presets" aria-label="Theme presets" data-i18n-aria-label="settings.appearance.themePresets"></div>
                      </div>
                    </div>

                    <div class="appearance-settings-grid">
                      <div class="settings-card-section-heading settings-card-section-heading--inline">
                        <span data-i18n="settings.appearance.themeCustomization">Theme Customization</span>
                      </div>
                      <div class="appearance-subcard">
                        <div class="appearance-control-group appearance-control-group--theme-colors">
                          <label class="appearance-control-label" data-i18n="settings.appearance.themeColors">Theme Colors</label>
                          <div id="appearance-theme-colors" class="appearance-theme-colors"></div>
                        </div>
                        <div class="appearance-range-stack">
                          <div class="appearance-control-group appearance-control-group--temperature">
                            <label class="appearance-control-label" for="appearance-temperature" data-i18n="settings.appearance.colorTemperature">Color Temperature</label>
                            <div class="settings-range-control">
                              <input id="appearance-temperature" class="binding-volume-slider" type="range" min="0" max="100" step="1" value="50" />
                              <span id="appearance-temperature-value" class="settings-range-value">50%</span>
                            </div>
                          </div>
                          <div class="appearance-inline-control appearance-inline-control--background-glow">
                            <label class="appearance-control-label" for="appearance-background-glow" data-i18n="settings.appearance.backgroundGlow">Background Glow</label>
                            <div class="settings-range-control">
                              <input id="appearance-background-glow" class="binding-volume-slider" type="range" min="0" max="100" step="1" value="30" />
                              <span id="appearance-background-glow-value" class="settings-range-value">30%</span>
                            </div>
                          </div>
                          <div class="appearance-inline-control appearance-inline-control--font-size">
                            <label class="appearance-control-label" for="appearance-font-size" data-i18n="settings.appearance.fontSize">Font Size</label>
                            <div class="settings-range-control">
                              <input id="appearance-font-size" class="binding-volume-slider" type="range" min="11" max="18" step="1" value="14" />
                              <span id="appearance-font-size-value" class="settings-range-value">14px</span>
                            </div>
                          </div>
                          <div class="appearance-inline-control appearance-inline-control--surface-contrast">
                            <label class="appearance-control-label" for="appearance-surface-contrast" data-i18n="settings.appearance.surfaceContrast">Surface Contrast</label>
                            <div class="settings-range-control">
                              <input id="appearance-surface-contrast" class="binding-volume-slider" type="range" min="0" max="100" step="1" value="50" />
                              <span id="appearance-surface-contrast-value" class="settings-range-value">50%</span>
                            </div>
                          </div>
                          <div class="appearance-inline-control appearance-inline-control--icon-glow">
                            <label class="appearance-control-label" for="appearance-icon-glow" data-i18n="settings.appearance.iconGlow">Icon Glow</label>
                            <div class="settings-range-control">
                              <input id="appearance-icon-glow" class="binding-volume-slider" type="range" min="0" max="100" step="1" value="50" />
                              <span id="appearance-icon-glow-value" class="settings-range-value">50%</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div id="appearance-color-popover" class="appearance-color-popover hidden" role="dialog" aria-label="Custom color" data-i18n-aria-label="settings.appearance.customColor">
                      <div class="appearance-color-popover-header">
                        <span id="appearance-color-popover-title" data-i18n="settings.appearance.customColor">Custom Color</span>
                        <button type="button" class="appearance-color-close" data-appearance-color-close aria-label="Close" data-i18n-aria-label="common.close">
                          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                            <path d="M6 6l12 12"></path>
                            <path d="M18 6L6 18"></path>
                          </svg>
                        </button>
                      </div>
                      <div id="appearance-color-field" class="appearance-color-field" tabindex="0" aria-label="Custom color" data-i18n-aria-label="settings.appearance.customColor">
                        <span class="appearance-color-field-handle" aria-hidden="true"></span>
                      </div>
                      <input id="appearance-color-hue" class="appearance-color-hue" type="range" min="0" max="359" step="1" value="210" aria-label="Hue" data-i18n-aria-label="settings.appearance.hue" />
                      <div id="appearance-color-suggestions" class="appearance-color-suggestions" aria-label="Suggested colors" data-i18n-aria-label="settings.appearance.suggestedColors"></div>
                      <div class="appearance-color-footer">
                        <span class="appearance-color-preview" aria-hidden="true"></span>
                        <input id="appearance-color-hex" class="appearance-color-hex" type="text" value="#5aa7ff" maxlength="7" spellcheck="false" aria-label="Hex color" data-i18n-aria-label="settings.appearance.hexColor" />
                      </div>
                    </div>

                  </div>
                </section>

                <section class="settings-section settings-section-panel settings-maintenance-section settings-reset-section" data-settings-panel="maintenance">
                  <div class="settings-maintenance-layout">
                    <div class="settings-card settings-maintenance-card settings-maintenance-card--diagnostics">
                      <div class="settings-maintenance-card-top">
                        <div class="settings-maintenance-card-main">
                          <span class="settings-maintenance-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" focusable="false">
                              <path d="M3.75 7.75h5l1.75 2h9.75v8.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2Z"></path>
                              <path d="M3.75 7.75v-1a2 2 0 0 1 2-2h3.1l1.75 2H18.25a2 2 0 0 1 2 2v1"></path>
                            </svg>
                          </span>
                          <span class="settings-maintenance-copy">
                            <span class="settings-maintenance-title" data-i18n="settings.diagnostics">Diagnostics</span>
                            <span class="settings-maintenance-description" data-i18n="settings.diagnosticsDescription">View application logs and diagnostics.</span>
                          </span>
                        </div>
                        <button id="open-logs-folder" type="button" class="settings-action settings-maintenance-button">
                          <span class="settings-button-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" focusable="false">
                              <path d="M3.75 7.75h5l1.75 2h9.75v8.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2Z"></path>
                              <path d="M3.75 7.75v-1a2 2 0 0 1 2-2h3.1l1.75 2H18.25a2 2 0 0 1 2 2v1"></path>
                            </svg>
                          </span>
                          <span class="settings-button-label" data-i18n="settings.openLogsFolder">Open Logs Folder</span>
                        </button>
                      </div>
                      <div class="settings-maintenance-inset">
                        <span class="settings-maintenance-inset-title" data-i18n="settings.logFiles">Log files</span>
                        <span class="settings-maintenance-inset-text" data-i18n="settings.logFilesDescription">Logs can help troubleshoot issues with devices, updates, plugins, and app startup.</span>
                      </div>
                    </div>

                    <div class="settings-card settings-maintenance-card settings-maintenance-card--privacy">
                      <div class="settings-maintenance-card-top">
                        <div class="settings-maintenance-card-main">
                          <span class="settings-maintenance-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" focusable="false">
                              <path d="M12 3.75 5.25 6.5v5.1c0 4.25 2.7 7.55 6.75 8.65 4.05-1.1 6.75-4.4 6.75-8.65V6.5Z"></path>
                              <path d="M9 12.25 11.1 14.25 15.25 9.75"></path>
                            </svg>
                          </span>
                          <span class="settings-maintenance-copy">
                            <span class="settings-maintenance-title" data-i18n="settings.midiDeviceInventory">MIDI Device Inventory</span>
                            <span class="settings-maintenance-description" data-i18n="settings.midiDeviceInventoryDescription">When enabled, shares app version, privacy notice version, MIDI input/output names, local MIDI port IDs, selected routes, and counts.</span>
                          </span>
                        </div>
                        <label class="settings-maintenance-toggle-control" title="Share MIDI device inventory" data-i18n-title="settings.midiDeviceInventoryToggle">
                          <span class="settings-maintenance-toggle-copy">
                            <span class="settings-maintenance-toggle-label" data-i18n="settings.midiDeviceInventoryToggle">Share inventory</span>
                          </span>
                          <span class="settings-toggle">
                            <input id="midi-device-inventory-consent-toggle" type="checkbox" />
                            <span class="plugins-toggle-ui" aria-hidden="true"></span>
                          </span>
                        </label>
                      </div>
                    </div>

                    <div class="settings-card settings-maintenance-card settings-maintenance-card--danger">
                      <div class="settings-maintenance-card-top">
                        <div class="settings-maintenance-card-main">
                          <span class="settings-maintenance-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" focusable="false">
                              <path d="M4.75 7.75h14.5"></path>
                              <path d="M9.25 4.75h5.5"></path>
                              <path d="M8 7.75v10.5a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5V7.75"></path>
                              <path d="M10 11v5"></path>
                              <path d="M14 11v5"></path>
                            </svg>
                          </span>
                          <span class="settings-maintenance-copy">
                            <span class="settings-maintenance-title" data-i18n="settings.appData">App Data</span>
                            <span class="settings-maintenance-description" data-i18n="settings.appDataDescription">Resetting app data will restore all settings to their default values.</span>
                          </span>
                        </div>
                        <button id="reset-app-data" type="button" class="settings-reset settings-maintenance-button settings-maintenance-button--danger">
                          <span class="settings-button-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" focusable="false">
                              <path d="M4.75 7.75h14.5"></path>
                              <path d="M9.25 4.75h5.5"></path>
                              <path d="M8 7.75v10.5a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5V7.75"></path>
                              <path d="M10 11v5"></path>
                              <path d="M14 11v5"></path>
                            </svg>
                          </span>
                          <span class="settings-button-label" data-i18n="settings.resetAppData">Reset App Data</span>
                        </button>
                      </div>
                      <div class="settings-maintenance-inset settings-maintenance-inset--danger">
                        <span class="settings-maintenance-warning" data-i18n="settings.cannotUndo">This action cannot be undone.</span>
                        <span class="settings-maintenance-inset-text" data-i18n="settings.resetAppDataDescription">Profiles, bindings, device selections, and saved app settings will be restored to defaults.</span>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
          <button id="settings-panel-close" type="button" class="visually-hidden" aria-hidden="true" data-i18n="common.close">Close</button>
        </section>`;
