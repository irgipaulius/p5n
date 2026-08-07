/** Block browser pull-to-refresh when dragging down on the map (Android Chrome). */
export function installPullRefreshGuard(mapEl: HTMLElement): void {
  let startY = 0;
  let active = false;

  mapEl.addEventListener(
    "touchstart",
    (e) => {
      startY = e.touches[0].clientY;
      active = true;
    },
    { passive: true },
  );

  mapEl.addEventListener(
    "touchmove",
    (e) => {
      if (!active) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 4) e.preventDefault();
    },
    { passive: false },
  );

  mapEl.addEventListener(
    "touchend",
    () => {
      active = false;
    },
    { passive: true },
  );

  mapEl.addEventListener(
    "touchcancel",
    () => {
      active = false;
    },
    { passive: true },
  );
}
