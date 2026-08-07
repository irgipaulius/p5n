/** Zoom tiers — server grid bubbles → bbox pins → (future) chunk detail. */

/** Pre-aggregated geohash4 counts from pin_grid (tiny payload). */
export const GRID_MAX_ZOOM = 8;

/** No minimum zoom — grid/bbox always eligible. */
export const PIN_FETCH_MIN_ZOOM = 0;

/** Max pins requested per bbox fetch (scales with zoom on client). */
export function bboxPinLimit(zoom: number): number {
  if (zoom < 8) return 1500;
  if (zoom < 10) return 2500;
  if (zoom < 12) return 4000;
  return 5000;
}
