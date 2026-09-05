// Declarative markup: kept intact to preserve DOM hierarchy and CSS selectors.
export const targetsTemplate = `<div id="target-panel" class="target-panel hidden">
    <div class="target-panel-content">
      <div class="target-panel-header">
        <div class="target-panel-header-left">
          <button id="target-panel-back" type="button" class="target-panel-back" title="Back" aria-label="Back" data-i18n-title="common.back" data-i18n-aria-label="common.back">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <span id="target-panel-title" data-i18n="targets.selectTarget">Select Target</span>
        </div>
        <button id="target-panel-close" type="button" class="target-panel-close">x</button>
      </div>
      <div class="target-panel-search-shell">
        <label class="target-panel-search">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />
          </svg>
          <input id="target-panel-search" type="search" placeholder="Search targets..." autocomplete="off" data-i18n-placeholder="targets.searchPlaceholder" />
        </label>
      </div>
      <div class="target-panel-body">
        <div id="target-panel-categories" class="target-panel-categories" aria-label="Target categories" data-i18n-aria-label="targets.categories"></div>
        <div id="target-panel-list" class="target-panel-list"></div>
      </div>
    </div>
  </div>`;
