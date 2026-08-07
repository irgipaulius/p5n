/** World grid + MCP-style sample points for gap-fill discovery. */

export interface Cell {
  id: string;
  lat: number;
  lng: number;
}

export interface SamplePoint {
  lat: number;
  lng: number;
}

const WORLD_LAT_MIN = -55;
const WORLD_LAT_MAX = 72;
const WORLD_LNG_MIN = -180;
const WORLD_LNG_MAX = 179;
const WORLD_STEP = 1;

/** ~1° worldwide grid for gap-fill pass. */
export function buildWorldGrid(step = WORLD_STEP): Cell[] {
  const cells: Cell[] = [];
  for (let lat = WORLD_LAT_MIN; lat <= WORLD_LAT_MAX; lat += step) {
    for (let lng = WORLD_LNG_MIN; lng <= WORLD_LNG_MAX; lng += step) {
      const id = `${lat.toFixed(2)}:${lng.toFixed(2)}`;
      cells.push({ id, lat, lng });
    }
  }
  return cells;
}

export function worldGridCellCount(step = WORLD_STEP): number {
  const latSteps = Math.floor((WORLD_LAT_MAX - WORLD_LAT_MIN) / step) + 1;
  const lngSteps = Math.floor((WORLD_LNG_MAX - WORLD_LNG_MIN) / step) + 1;
  return latSteps * lngSteps;
}

export function worldGridCellAt(index: number, step = WORLD_STEP): Cell | null {
  const latSteps = Math.floor((WORLD_LAT_MAX - WORLD_LAT_MIN) / step) + 1;
  const lngSteps = Math.floor((WORLD_LNG_MAX - WORLD_LNG_MIN) / step) + 1;
  const total = latSteps * lngSteps;
  if (index < 0 || index >= total) return null;
  const latIdx = Math.floor(index / lngSteps);
  const lngIdx = index % lngSteps;
  const lat = WORLD_LAT_MIN + latIdx * step;
  const lng = WORLD_LNG_MIN + lngIdx * step;
  return { id: `${lat.toFixed(2)}:${lng.toFixed(2)}`, lat, lng };
}

/** Europe-focused grid (legacy passes). Step ~1° ≈ 100 km. */
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

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** MCP-style cardinal rings — 1 / 5 / 9 / 13 points by radius. */
export function samplePointsForCell(lat: number, lon: number, radiusKm: number): SamplePoint[] {
  const points: SamplePoint[] = [{ lat, lng: lon }];

  if (radiusKm < 15) return points.map(roundPoint);

  const kmPerDegLat = 111;
  const kmPerDegLon = 111 * Math.cos((lat * Math.PI) / 180);

  let rings: number[];
  if (radiusKm < 35) rings = [0.6];
  else if (radiusKm < 60) rings = [0.4, 0.75];
  else rings = [0.33, 0.6, 0.85];

  for (const pct of rings) {
    const offsetKm = radiusKm * pct;
    const dLat = offsetKm / kmPerDegLat;
    const dLon = offsetKm / kmPerDegLon;
    points.push(
      { lat: lat + dLat, lng: lon },
      { lat: lat - dLat, lng: lon },
      { lat, lng: lon + dLon },
      { lat, lng: lon - dLon },
    );
  }

  return points.map(roundPoint);
}

/** Four child centers when a query hits the API cap. */
export function subdivisionPoints(lat: number, lng: number, halfDeg: number): SamplePoint[] {
  const q = halfDeg / 2;
  return [
    { lat: lat + q, lng: lng + q },
    { lat: lat + q, lng: lng - q },
    { lat: lat - q, lng: lng + q },
    { lat: lat - q, lng: lng - q },
  ].map(roundPoint);
}

function roundPoint(p: SamplePoint): SamplePoint {
  return { lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5 };
}

export const CELL_RADIUS_KM = 55;
export const FILTER_CAP = 100;
export const MERGE_RADIUS_KM = 12;
export const MAX_SUBDIVIDE_DEPTH = 3;
export const PIN_GRID_DENSITY_THRESHOLD = 50;
