import type maplibregl from "maplibre-gl";
import type { PinFeature } from "../types";

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

let loadTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleViewportPins(
  map: maplibregl.Map,
  apiBase: string,
  onPins: (pins: PinFeature[]) => void,
  delayMs = 250,
): void {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    void fetchViewportPins(apiBase, map).then(onPins);
  }, delayMs);
}
