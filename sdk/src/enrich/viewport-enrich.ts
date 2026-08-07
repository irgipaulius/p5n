import type maplibregl from "maplibre-gl";
import { decodeEnrich, type CompactEnrich } from "../../../shared/pin-compact";
import { applyGeoJsonEnrichmentFeatureState } from "../layers/pins";
import { shouldUseGrid } from "../pins/viewport-pins";

export async function enrichVisiblePins(
  map: maplibregl.Map,
  apiBase: string,
  sourceId: string,
  pinIds: string[],
): Promise<number> {
  if (pinIds.length === 0 || shouldUseGrid(map)) return 0;
  const ids = pinIds.slice(0, 500);
  const params = new URLSearchParams({ ids: ids.join(",") });
  const resp = await fetch(`${apiBase}/api/enrich?${params}`);
  if (!resp.ok) return 0;
  const { e } = (await resp.json()) as { e?: CompactEnrich[] };
  if (!e?.length) return 0;
  applyGeoJsonEnrichmentFeatureState(
    map,
    sourceId,
    e.map((row) => {
      const d = decodeEnrich(row);
      return { id: d.id, rating: d.rating, reviews: d.reviews, attrs0: d.attrs0, attrs1: d.attrs1 };
    }),
  );
  return e.length;
}

let enrichTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleViewportEnrich(
  map: maplibregl.Map,
  apiBase: string,
  sourceId: string,
  pinIds: string[],
  delayMs = 400,
): void {
  if (pinIds.length === 0 || shouldUseGrid(map)) return;
  if (enrichTimer) clearTimeout(enrichTimer);
  enrichTimer = setTimeout(() => {
    void enrichVisiblePins(map, apiBase, sourceId, pinIds);
  }, delayMs);
}
