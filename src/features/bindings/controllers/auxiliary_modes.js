/** auxiliary modes workflow. */
export function createAuxiliaryModes({
  buttonLightSelectValue,
  elements,
  listState,
  renderButtonLightDropdown,
  syncIndicatorUi,
  t,
}) {
  function syncButtonLightUi(binding) {
    const select = elements.bindingConfigButtonLightSelect;
    if (!select) return;
    select.value = buttonLightSelectValue(binding);
    select.disabled = false;
    select.title = t("bindings.toggleMuteLight");
    const row = elements.bindingConfigButtonLightSelectRow || select.closest?.(".binding-config-select-row");
    if (row) {
      row.classList.remove("is-disabled");
      row.classList.remove("hidden");
    }
    if (listState.buttonLightDropdown) {
      listState.buttonLightDropdown.button.disabled = false;
      listState.buttonLightDropdown.button.title = t("bindings.toggleMuteLight");
      listState.buttonLightDropdown.button.setAttribute("aria-disabled", "false");
      listState.buttonLightDropdown.root.classList.remove("is-disabled");
      renderButtonLightDropdown();
    }
    syncIndicatorUi(binding);
  }

  return { syncButtonLightUi };
}
