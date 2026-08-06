import type maplibregl from "maplibre-gl";
import { geohash4CellsForBbox } from "../geohash";
import type { PinFeature } from "../types";
import type { PinSessionCache } from "./pin-cache";

export function expandedBbox(
  map: maplibregl.Map,
  padRatio = 0.2,
): { west: number; south: number; east: number; north: number } {
  const b = map.getBounds();
  const w = b.getEast() - b.getWest();
  const h = b.getNorth() - b.getSouth();
  return {
    west: b.getWest() - w * padRatio,
    south: b.getSouth() - h * padRatio,
    east: b.getEast() + w * padRatio,
    north: b.getNorth() + h * padRatio,
  };
}

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

const MAX_TILES_PER_REQUEST = 40;

export async function fetchViewportPins(apiBase: string, map: maplibregl.Map): Promise<PinFeature[]> {
  const { west, south, east, north } = expandedBbox(map);
  const params = new URLSearchParams({
    west: String(west),
    south: String(south),
    east: String(east),
    north: String(north),
    limit: "5000",
  });
  const resp = await fetch(`${apiBase}/api/pins/bbox?${params}`);
  if (!resp.ok) return [];
  const data = (await resp.json()) as { pins: PinFeature[] };
  return data.pins ?? [];
}

async function fetchPinTiles(apiBase: string, g4cells: string[]): Promise<Record<string, PinFeature[]>> {
  const merged: Record<string, PinFeature[]> = {};
  for (let i = 0; i < g4cells.length; i += MAX_TILES_PER_REQUEST) {
    const chunk = g4cells.slice(i, i + MAX_TILES_PER_REQUEST);
    const params = new URLSearchParams({ g4: chunk.join(",") });
    const resp = await fetch(`${apiBase}/api/pins/tiles?${params}`);
    if (!resp.ok) continue;
    const data = (await resp.json()) as { tiles?: Record<string, PinFeature[]> };
    if (data.tiles) {
      for (const [g4, pins] of Object.entries(data.tiles)) {
        merged[g4] = pins;
      }
    }
  }
  return merged;
}

/** Load missing geohash4 tiles into cache; render from cache only. */
export async function syncViewportPins(
  apiBase: string,
  map: maplibregl.Map,
  cache: PinSessionCache,
): Promise<{ visible: number; fetched: number; cached: number }> {
  const bbox = expandedBbox(map);
  const cells = geohash4CellsForBbox(bbox);
  const missing = cache.missingTiles(cells);

  if (missing.length > 0) {
    const tiles = await fetchPinTiles(apiBase, missing);
    cache.mergeTiles(tiles);
  }

  const visible = cache.pinsInBbox(bbox);
  return { visible: visible.length, fetched: missing.length, cached: cache.size };
}

let loadTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleViewportPins(
  map: maplibregl.Map,
  apiBase: string,
  cache: PinSessionCache,
  onPins: (pins: PinFeature[], meta: { fromCache: boolean }) => void,
  delayMs = 250,
): void {
  const bbox = expandedBbox(map);
  onPins(cache.pinsInBbox(bbox), { fromCache: true });

  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    void syncViewportPins(apiBase, map, cache).then(() => {
      onPins(cache.pinsInBbox(expandedBbox(map)), { fromCache: false });
    });
  }, delayMs);
}
