/** 10°×10° world chunks for regional PMTiles bake + lazy load. */

export const CHUNK_DEG = 10;

export function chunkBand(value: number): number {
  return Math.floor(value / CHUNK_DEG) * CHUNK_DEG;
}

export function chunkIdFor(lat: number, lng: number): string {
  return `${chunkBand(lat)}_${chunkBand(lng)}`;
}

export function chunkIdsForBbox(bbox: {
  west: number;
  south: number;
  east: number;
  north: number;
}): string[] {
  const ids: string[] = [];
  const lat0 = chunkBand(bbox.south);
  const lat1 = chunkBand(bbox.north);
  const lng0 = chunkBand(bbox.west);
  const lng1 = chunkBand(bbox.east);
  for (let lat = lat0; lat <= lat1; lat += CHUNK_DEG) {
    for (let lng = lng0; lng <= lng1; lng += CHUNK_DEG) {
      ids.push(`${lat}_${lng}`);
    }
  }
  return ids;
}

export function chunkBbox(id: string): { west: number; south: number; east: number; north: number } {
  const [latS, lngS] = id.split("_").map(Number);
  return { west: lngS, south: latS, east: lngS + CHUNK_DEG, north: latS + CHUNK_DEG };
}

/** Load regional PMTiles once the map is zoomed in enough. */
export const CHUNK_LOAD_MIN_ZOOM = 3;

/** Fetch live pins from API (clustered) — low threshold; GPU clustering handles density. */
export const PIN_FETCH_MIN_ZOOM = 4;
