/** Swipe down to dismiss the place detail sheet (mobile). */
export function installDetailSwipe(detail: HTMLElement, onClose: () => void): void {
  let startY = 0;
  let tracking = false;
  let scrollTopAtStart = 0;

  detail.addEventListener(
    "touchstart",
    (e) => {
      if (!detail.classList.contains("open")) return;
      scrollTopAtStart = detail.scrollTop;
      startY = e.touches[0].clientY;
      tracking = true;
      detail.classList.add("detail-dragging");
    },
    { passive: true },
  );

  detail.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking) return;
      const dy = e.touches[0].clientY - startY;
      if (scrollTopAtStart > 0 && dy <= 0) {
        tracking = false;
        detail.classList.remove("detail-dragging");
        detail.style.transform = "";
        return;
      }
      if (dy <= 0) return;
      e.preventDefault();
      detail.style.transform = `translateY(${dy}px)`;
    },
    { passive: false },
  );

  const finish = (clientY: number) => {
    if (!tracking) return;
    tracking = false;
    detail.classList.remove("detail-dragging");
    const dy = clientY - startY;
    const threshold = Math.min(96, detail.offsetHeight * 0.18);
    detail.style.transform = "";
    if (dy > threshold) onClose();
  };

  detail.addEventListener(
    "touchend",
    (e) => {
      finish(e.changedTouches[0]?.clientY ?? startY);
    },
    { passive: true },
  );

  detail.addEventListener(
    "touchcancel",
    () => {
      tracking = false;
      detail.classList.remove("detail-dragging");
      detail.style.transform = "";
    },
    { passive: true },
  );
}
