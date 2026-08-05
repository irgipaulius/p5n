import type maplibregl from "maplibre-gl";
import { applyEnrichmentFeatureState } from "../layers/pins";

export async function enrichViewport(
  map: maplibregl.Map,
  apiBase: string,
  sourceId: string,
  since?: string,
): Promise<number> {
  const b = map.getBounds();
  const params = new URLSearchParams({
    west: String(b.getWest()),
    south: String(b.getSouth()),
    east: String(b.getEast()),
    north: String(b.getNorth()),
  });
  if (since) params.set("since", since);

  const resp = await fetch(`${apiBase}/api/enrich?${params}`);
  if (!resp.ok) return 0;
  const { pins } = (await resp.json()) as {
    pins: Array<{ id: string; rating?: number; reviews?: number; attrs0?: number; attrs1?: number }>;
  };
  applyEnrichmentFeatureState(map, sourceId, pins);
  return pins.length;
}

let enrichTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleViewportEnrich(
  map: maplibregl.Map,
  apiBase: string,
  sourceId: string,
  since?: string,
  delayMs = 300,
): void {
  if (enrichTimer) clearTimeout(enrichTimer);
  enrichTimer = setTimeout(() => {
    void enrichViewport(map, apiBase, sourceId, since);
  }, delayMs);
}
