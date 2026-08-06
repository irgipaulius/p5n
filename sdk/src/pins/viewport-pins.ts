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

const MAX_TILES_PER_REQUEST = 96;
const MAX_PARALLEL_REQUESTS = 8;

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

async function fetchPinTileChunk(
  apiBase: string,
  chunk: string[],
): Promise<Record<string, PinFeature[]>> {
  const params = new URLSearchParams({ g4: chunk.join(",") });
  const resp = await fetch(`${apiBase}/api/pins/tiles?${params}`);
  if (!resp.ok) return {};
  const data = (await resp.json()) as { tiles?: Record<string, PinFeature[]> };
  return data.tiles ?? {};
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

/** Load missing geohash4 tiles into cache; render from cache only. */
export async function syncViewportPins(
  apiBase: string,
  map: maplibregl.Map,
  cache: PinSessionCache,
  onProgress?: () => void,
): Promise<{ visible: number; fetched: number; cached: number }> {
  const bbox = expandedBbox(map);
  const cells = geohash4CellsForBbox(bbox);
  const missing = cache.missingTiles(cells);

  if (missing.length > 0) {
    await fetchPinTiles(apiBase, missing, (tiles) => {
      cache.mergeTiles(tiles);
      onProgress?.();
    });
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
  const delay = cache.size === 0 ? 0 : delayMs;
  loadTimer = setTimeout(() => {
    void syncViewportPins(apiBase, map, cache, () => {
      onPins(cache.pinsInBbox(expandedBbox(map)), { fromCache: false });
    }).then(() => {
      onPins(cache.pinsInBbox(expandedBbox(map)), { fromCache: false });
    });
  }, delay);
}
