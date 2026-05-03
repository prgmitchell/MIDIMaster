import {
  closeOpenDropdowns,
  renderLabelWithBadges,
  wireDropdownToggle,
} from "./dropdown_badges.js";

export function createSelectDropdownShell({
  selectEl,
  rootClass = "",
  title = "Select",
}) {
  if (!selectEl) return null;

  selectEl.classList.add("hidden");

  const root = document.createElement("div");
  root.className = `target-dropdown ${rootClass}`.trim();

  const button = document.createElement("button");
  button.type = "button";
  button.className = "target-button";
  button.title = title;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  const display = document.createElement("span");
  display.className = "target-display";

  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "\u25be";

  button.appendChild(display);
  button.appendChild(caret);

  const menu = document.createElement("div");
  menu.className = "target-menu hidden";
  root.__positionDropdownMenu = () => {
    if (!root.classList.contains("settings-select-dropdown") || menu.classList.contains("hidden")) return;
    const rect = button.getBoundingClientRect();
    const gap = 6;
    const viewportPadding = 14;
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding - gap;
    const availableAbove = rect.top - viewportPadding - gap;
    const maxHeight = Math.max(160, Math.min(280, Math.max(availableBelow, availableAbove)));

    menu.style.position = "fixed";
    menu.style.left = `${Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - rect.width - viewportPadding))}px`;
    menu.style.width = `${rect.width}px`;
    menu.style.minWidth = `${rect.width}px`;
    menu.style.maxWidth = `${Math.max(120, window.innerWidth - (viewportPadding * 2))}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.zIndex = "1000";

    const menuHeight = Math.min(menu.scrollHeight || maxHeight, maxHeight);
    const openUp = availableBelow < Math.min(180, menuHeight) && availableAbove > availableBelow;
    const top = openUp
      ? Math.max(viewportPadding, rect.top - gap - menuHeight)
      : Math.min(rect.bottom + gap, window.innerHeight - viewportPadding - menuHeight);
    menu.style.top = `${top}px`;
    menu.style.right = "auto";
  };
  wireDropdownToggle({ root, menu, trigger: button });

  root.appendChild(button);
  root.appendChild(menu);
  selectEl.insertAdjacentElement("afterend", root);
  window.addEventListener("resize", root.__positionDropdownMenu);
  window.addEventListener("scroll", root.__positionDropdownMenu, true);

  return { root, menu, display, button };
}

export function renderNativeSelectDropdown({
  entry,
  selectEl,
  fallbackText = "Select",
  closeDropdowns = () => closeOpenDropdowns({ except: null }),
  formatOptionText = (opt) => opt.textContent || "",
  getOptionBadges = () => [],
  getDisplayBadges = getOptionBadges,
  onOptionSelected = null,
  truncateMenuLabels = false,
  truncateDisplayLabel = true,
}) {
  if (!entry || !entry.menu || !entry.display || !selectEl) return;

  const options = Array.from(selectEl.options || []).filter((opt) => String(opt.value || "").trim());
  const selectedValue = String(selectEl.value || "");
  entry.menu.innerHTML = "";

  let activeOption = options.find((opt) => opt.value === selectedValue) || null;

  options.forEach((opt) => {
    const optionButton = document.createElement("button");
    optionButton.type = "button";
    optionButton.className = "target-option";
    if (opt.value === selectedValue) optionButton.classList.add("selected");

    const optionLabel = document.createElement("span");
    optionLabel.className = "target-label";
    renderLabelWithBadges(optionLabel, {
      text: formatOptionText(opt),
      badges: getOptionBadges(opt),
      truncate: truncateMenuLabels,
    });
    optionButton.appendChild(optionLabel);

    optionButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectEl.value = opt.value;
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof onOptionSelected === "function") {
        onOptionSelected(opt);
      }
      closeDropdowns();
    });

    entry.menu.appendChild(optionButton);
  });

  renderLabelWithBadges(entry.display, {
    text: activeOption ? formatOptionText(activeOption) : fallbackText,
    badges: activeOption ? getDisplayBadges(activeOption) : [],
    truncate: truncateDisplayLabel,
  });
}
