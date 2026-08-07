import type maplibregl from "maplibre-gl";
import { decodePin, type CompactPin } from "../../../shared/pin-compact";
import { bboxPinLimit } from "../../../shared/pin-zoom-tiers";
import { geohash4CellsForBbox } from "../geohash";
import type { PinFeature } from "../types";
import type { PinSessionCache } from "./pin-cache";
import { shouldFetchPins, shouldUseGrid, viewportBbox } from "./zoom-policy";

export { viewportBbox as expandedBbox, shouldFetchPins, shouldUseGrid };

export function pinInBbox(
  pin: { lat: number; lng: number },
  bbox: { west: number; south: number; east: number; north: number },
): boolean {
  return (
    pin.lng >= bbox.west &&
    pin.lng <= bbox.east &&
    pin.lat >= bbox.south &&
    pin.lat <= bbox.north
  );
}

const MAX_TILES_PER_REQUEST = 48;
const MAX_PARALLEL_REQUESTS = 4;
/** Hard cap on pins painted — never render 60k. */
export const MAX_PINS_IN_VIEW = 2500;

function maxCellsForZoom(z: number): number {
  if (z < 8) return 32;
  if (z < 10) return 48;
  return 64;
}

function compactToFeature(c: CompactPin): PinFeature {
  const p = decodePin(c);
  return { id: p.id, lat: p.lat, lng: p.lng, t: p.t };
}

export async function fetchViewportPins(
  apiBase: string,
  map: maplibregl.Map,
): Promise<PinFeature[]> {
  const { west, south, east, north } = viewportBbox(map);
  const limit = bboxPinLimit(map.getZoom());
  const params = new URLSearchParams({
    west: String(west),
    south: String(south),
    east: String(east),
    north: String(north),
    limit: String(limit),
  });
  const resp = await fetch(`${apiBase}/api/pins/bbox?${params}`);
  if (!resp.ok) return [];
  const data = (await resp.json()) as { p?: CompactPin[] };
  return (data.p ?? []).map(compactToFeature);
}

async function fetchPinTileChunk(
  apiBase: string,
  chunk: string[],
): Promise<Record<string, PinFeature[]>> {
  const params = new URLSearchParams({ g4: chunk.join(",") });
  const resp = await fetch(`${apiBase}/api/pins/tiles?${params}`);
  if (!resp.ok) return {};
  const data = (await resp.json()) as { t?: Record<string, CompactPin[]> };
  const out: Record<string, PinFeature[]> = {};
  for (const [g4, rows] of Object.entries(data.t ?? {})) {
    out[g4] = rows.map(compactToFeature);
  }
  return out;
}

async function fetchPinTiles(
  apiBase: string,
  g4cells: string[],
  onChunk?: (tiles: Record<string, PinFeature[]>) => void,
): Promise<Record<string, PinFeature[]>> {
  const chunks: string[][] = [];
  for (let i = 0; i < g4cells.length; i += MAX_TILES_PER_REQUEST) {
    chunks.push(g4cells.slice(i, i + MAX_TILES_PER_REQUEST));
  }

  const merged: Record<string, PinFeature[]> = {};

  for (let i = 0; i < chunks.length; i += MAX_PARALLEL_REQUESTS) {
    const wave = chunks.slice(i, i + MAX_PARALLEL_REQUESTS);
    const results = await Promise.all(wave.map((chunk) => fetchPinTileChunk(apiBase, chunk)));
    for (const tiles of results) {
      for (const [g4, pins] of Object.entries(tiles)) merged[g4] = pins;
      if (onChunk && Object.keys(tiles).length > 0) onChunk(tiles);
    }
  }

  return merged;
}

function capPins(pins: PinFeature[]): PinFeature[] {
  if (pins.length <= MAX_PINS_IN_VIEW) return pins;
  return pins.slice(0, MAX_PINS_IN_VIEW);
}

function visiblePins(map: maplibregl.Map, cache: PinSessionCache): PinFeature[] {
  return capPins(cache.pinsInBbox(viewportBbox(map)));
}

/** Mid/high zoom — bbox or geohash tiles. Grid handled separately. */
export async function syncViewportPins(
  apiBase: string,
  map: maplibregl.Map,
  cache: PinSessionCache,
  onProgress?: () => void,
): Promise<{ visible: number; fetched: number; cached: number }> {
  const visible = visiblePins(map, cache);

  if (!shouldFetchPins(map) || shouldUseGrid(map)) {
    return { visible: visible.length, fetched: 0, cached: cache.size };
  }

  const z = map.getZoom();
  cache.trimOutsideBbox(viewportBbox(map));

  if (z < 10) {
    const pins = await fetchViewportPins(apiBase, map);
    const added = cache.mergePins(pins);
    onProgress?.();
    const after = visiblePins(map, cache);
    return { visible: after.length, fetched: added, cached: cache.size };
  }

  const bbox = viewportBbox(map);
  let cells = geohash4CellsForBbox(bbox);
  const cap = maxCellsForZoom(z);
  if (cells.length > cap) cells = cells.slice(0, cap);
  const missing = cache.missingTiles(cells);

  if (missing.length > 0) {
    await fetchPinTiles(apiBase, missing, (tiles) => {
      cache.mergeTiles(tiles);
      onProgress?.();
    });
  }

  const after = visiblePins(map, cache);
  return { visible: after.length, fetched: missing.length, cached: cache.size };
}

let loadTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleViewportPins(
  map: maplibregl.Map,
  apiBase: string,
  cache: PinSessionCache,
  onPins: (pins: PinFeature[], meta: { fromCache: boolean }) => void,
  delayMs = 300,
): void {
  onPins(visiblePins(map, cache), { fromCache: true });

  if (!shouldFetchPins(map) || shouldUseGrid(map)) return;

  if (loadTimer) clearTimeout(loadTimer);
  const delay = cache.size === 0 ? 0 : delayMs;
  loadTimer = setTimeout(() => {
    void syncViewportPins(apiBase, map, cache, () => {
      onPins(visiblePins(map, cache), { fromCache: false });
    }).then(() => {
      onPins(visiblePins(map, cache), { fromCache: false });
    });
  }, delay);
}
