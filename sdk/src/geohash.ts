/** Client-side geohash helpers (match server src/geohash.ts). */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function encodeGeohash(lat: number, lng: number, precision = 6): string {
  let minLat = -90;
  let maxLat = 90;
  let minLng = -180;
  let maxLng = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (minLng + maxLng) / 2;
      if (lng >= mid) {
        ch = (ch << 1) + 1;
        minLng = mid;
      } else {
        ch = ch << 1;
        maxLng = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) {
        ch = (ch << 1) + 1;
        minLat = mid;
      } else {
        ch = ch << 1;
        maxLat = mid;
      }
    }
    even = !even;
    bit += 1;
    if (bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** Geohash4 cell prefixes overlapping a bbox (~20×20 km cells). */
export function geohash4CellsForBbox(
  bbox: { west: number; south: number; east: number; north: number },
  step = 0.12,
): string[] {
  const set = new Set<string>();
  for (let lat = bbox.south; lat <= bbox.north + 1e-9; lat += step) {
    for (let lng = bbox.west; lng <= bbox.east + 1e-9; lng += step) {
      set.add(encodeGeohash(lat, lng, 4));
    }
  }
  return [...set];
}
