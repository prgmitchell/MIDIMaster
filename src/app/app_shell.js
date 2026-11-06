export function createAppShell({
  appShell,
  sidebarNav,
  sidebarCollapseToggle,
  appPages,
  appNavItems,
  storageKey = "sidebarCollapsed",
  preparePage,
}) {
  let sidebarNavIndicatorRaf = 0;
  let sidebarNavIndicatorSettleTimeout = 0;
  const busyReasons = new Set();

  function setInteractionBusy(reason, busy) {
    if (busy) busyReasons.add(reason);
    else busyReasons.delete(reason);
    if (appShell) {
      appShell.inert = busyReasons.size > 0;
      if (appShell.inert) appShell.setAttribute("aria-busy", "true");
      else appShell.removeAttribute("aria-busy");
    }
  }

  function loadSidebarCollapsed() {
    try {
      return localStorage.getItem(storageKey) === "true";
    } catch {
      return false;
    }
  }

  function syncSidebarNavIndicator() {
    if (!sidebarNav) {
      return;
    }
    const indicator = sidebarNav.querySelector(".sidebar-nav-indicator");
    if (!indicator) {
      return;
    }
    const activeItem = appNavItems.find((item) => item.classList.contains("active"));
    if (!activeItem) {
      indicator.style.opacity = "0";
      return;
    }
    indicator.style.height = `${activeItem.offsetHeight}px`;
    indicator.style.transform = `translateY(${activeItem.offsetTop}px)`;
    indicator.style.opacity = "1";
  }

  function scheduleSidebarNavIndicatorSync(options = {}) {
    const settle = Boolean(options && options.settle);
    if (sidebarNavIndicatorRaf) {
      cancelAnimationFrame(sidebarNavIndicatorRaf);
    }
    sidebarNavIndicatorRaf = requestAnimationFrame(() => {
      sidebarNavIndicatorRaf = 0;
      syncSidebarNavIndicator();
    });
    if (settle) {
      if (sidebarNavIndicatorSettleTimeout) {
        clearTimeout(sidebarNavIndicatorSettleTimeout);
      }
      sidebarNavIndicatorSettleTimeout = window.setTimeout(() => {
        sidebarNavIndicatorSettleTimeout = 0;
        if (sidebarNavIndicatorRaf) {
          cancelAnimationFrame(sidebarNavIndicatorRaf);
        }
        sidebarNavIndicatorRaf = requestAnimationFrame(() => {
          sidebarNavIndicatorRaf = 0;
          syncSidebarNavIndicator();
        });
      }, 220);
    }
  }

  function applySidebarCollapsed(collapsed) {
    const isCollapsed = Boolean(collapsed);
    appShell?.classList?.toggle?.("sidebar-collapsed", isCollapsed);
    if (!sidebarCollapseToggle) return;
    const label = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
    sidebarCollapseToggle.setAttribute("aria-label", label);
    sidebarCollapseToggle.setAttribute("aria-pressed", String(isCollapsed));
    sidebarCollapseToggle.setAttribute("title", label);
    sidebarCollapseToggle.title = label;
    scheduleSidebarNavIndicatorSync({ settle: true });
  }

  function toggleSidebarCollapsed() {
    const next = !appShell?.classList?.contains?.("sidebar-collapsed");
    applySidebarCollapsed(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // ignore storage failures
    }
  }

  async function switchAppPage(page) {
    const nextPage = String(page || "bindings");
    const currentPage = appPages.find((panel) => panel.classList.contains("active"))?.dataset?.pagePanel || "bindings";
    if (currentPage === nextPage) {
      return;
    }
    appPages.forEach((panel) => {
      const active = panel.dataset.pagePanel === nextPage;
      panel.classList.toggle("active", active);
      panel.classList.toggle("hidden", !active);
    });
    appNavItems.forEach((item) => {
      const active = item.dataset.page === nextPage;
      item.classList.toggle("active", active);
      if (active) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });
    scheduleSidebarNavIndicatorSync();
    await preparePage?.(nextPage);
  }

  return {
    setInteractionBusy,
    loadSidebarCollapsed,
    applySidebarCollapsed,
    toggleSidebarCollapsed,
    scheduleSidebarNavIndicatorSync,
    switchAppPage,
  };
}
