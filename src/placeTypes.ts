/** Geo discovery grid for continuous / full / fetch-new passes. */

export interface Cell {
  id: string;
  lat: number;
  lng: number;
}

/** Europe-focused grid (park4night density). Step ~1° ≈ 100km. */
export function buildEuropeGrid(step = 1): Cell[] {
  const cells: Cell[] = [];
  for (let lat = 35; lat <= 72; lat += step) {
    for (let lng = -12; lng <= 45; lng += step) {
      const id = `${lat.toFixed(2)}:${lng.toFixed(2)}`;
      cells.push({ id, lat, lng });
    }
  }
  return cells;
}

export const PLACE_TYPE_LABELS: Record<string, string> = {
  C: "Camping",
  F: "Farm / private",
  P: "Parking",
  PN: "Nature / wild",
  PJ: "Parking day",
  OR: "Homestay / other",
  AR: "Aire",
  AC: "Aire camping-car",
  ACC_PR: "Private aire",
  PSS: "Service area",
  SF: "Sports / field",
  E: "Establishment",
};
