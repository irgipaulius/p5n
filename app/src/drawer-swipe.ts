/** Touch swipe to close the filters drawer on mobile. */
export function installDrawerSwipe(drawer: HTMLElement, onClose: () => void): void {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  const onStart = (clientX: number, clientY: number) => {
    startX = clientX;
    startY = clientY;
    tracking = true;
    drawer.style.transition = "none";
  };

  const onMove = (clientX: number, clientY: number) => {
    if (!tracking) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
      tracking = false;
      drawer.style.transition = "";
      drawer.style.transform = "";
      return;
    }
    if (dx > 0 && drawer.classList.contains("open")) {
      drawer.style.transform = `translateX(${dx}px)`;
    }
  };

  const onEnd = (clientX: number) => {
    if (!tracking) return;
    tracking = false;
    drawer.style.transition = "";
    const dx = clientX - startX;
    if (dx > Math.min(80, drawer.offsetWidth * 0.25)) onClose();
    drawer.style.transform = "";
  };

  drawer.addEventListener(
    "touchstart",
    (e) => {
      if (!drawer.classList.contains("open")) return;
      onStart(e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: true },
  );

  drawer.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking) return;
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: true },
  );

  drawer.addEventListener(
    "touchend",
    (e) => {
      const x = e.changedTouches[0]?.clientX ?? startX;
      onEnd(x);
    },
    { passive: true },
  );
}
