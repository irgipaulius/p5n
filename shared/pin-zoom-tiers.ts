/** Zoom tiers — server grid bubbles → bbox pins → (future) chunk detail. */

/** Pre-aggregated geohash4 counts from pin_grid (tiny payload). */
export const GRID_MAX_ZOOM = 8;

/** No minimum zoom — grid/bbox always eligible. */
export const PIN_FETCH_MIN_ZOOM = 0;

/** Zoom at which PMTiles carries individual pin tiles (post re-bake with tile_count). */
export const PMTILES_DETAIL_MIN_ZOOM = 10;

/** Baked PMTiles with enough detail tiles to show vector pins (not just heatmap). */
export const PMTILES_DETAIL_TILE_MIN = 500;
export function bboxPinLimit(zoom: number): number {
  if (zoom < 8) return 1500;
  if (zoom < 10) return 2500;
  if (zoom < 12) return 4000;
  return 5000;
}
