import type maplibregl from "maplibre-gl";
import { CHUNK_LOAD_MIN_ZOOM, PIN_FETCH_MIN_ZOOM } from "../../../shared/tile-chunks";

export { CHUNK_LOAD_MIN_ZOOM, PIN_FETCH_MIN_ZOOM };

export function mapZoom(map: maplibregl.Map): number {
  return map.getZoom();
}

export function shouldLoadChunks(map: maplibregl.Map): boolean {
  return mapZoom(map) >= CHUNK_LOAD_MIN_ZOOM;
}

export function shouldFetchPins(map: maplibregl.Map): boolean {
  return mapZoom(map) >= PIN_FETCH_MIN_ZOOM;
}

/** Tighter viewport at low zoom — avoid painting the whole cache. */
export function viewportBbox(
  map: maplibregl.Map,
  padRatio = 0.2,
): { west: number; south: number; east: number; north: number } {
  const z = mapZoom(map);
  const pad = z < PIN_FETCH_MIN_ZOOM ? 0.05 : z < 10 ? 0.12 : padRatio;
  const b = map.getBounds();
  const w = b.getEast() - b.getWest();
  const h = b.getNorth() - b.getSouth();
  return {
    west: b.getWest() - w * pad,
    south: b.getSouth() - h * pad,
    east: b.getEast() + w * pad,
    north: b.getNorth() + h * pad,
  };
}
