import type maplibregl from "maplibre-gl";
import { colorForType } from "../colors";

const MATCH_T = ["get", "t"] as maplibregl.ExpressionSpecification;

export function addPinLayers(
  map: maplibregl.Map,
  sourceId: string,
  opts: { circleLayerId?: string; symbolLayerId?: string } = {},
): void {
  const circleId = opts.circleLayerId ?? `${sourceId}-circles`;
  const symbolId = opts.symbolLayerId ?? `${sourceId}-symbols`;

  if (!map.getLayer(circleId)) {
    map.addLayer({
      id: circleId,
      type: "circle",
      source: sourceId,
      "source-layer": "pins",
      minzoom: 0,
      maxzoom: 12,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2, 8, 4, 12, 6],
        "circle-color": [
          "match",
          MATCH_T,
          1, colorForType(1),
          2, colorForType(2),
          3, colorForType(3),
          4, colorForType(4),
          5, colorForType(5),
          6, colorForType(6),
          7, colorForType(7),
          8, colorForType(8),
          9, colorForType(9),
          10, colorForType(10),
          11, colorForType(11),
          12, colorForType(12),
          colorForType(3),
        ],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#0f172a",
        "circle-opacity": 0.92,
      },
    });
  }

  if (!map.getLayer(symbolId)) {
    map.addLayer({
      id: symbolId,
      type: "circle",
      source: sourceId,
      "source-layer": "pins",
      minzoom: 12,
      paint: {
        "circle-radius": 8,
        "circle-color": [
          "match",
          MATCH_T,
          1, colorForType(1),
          2, colorForType(2),
          3, colorForType(3),
          4, colorForType(4),
          5, colorForType(5),
          6, colorForType(6),
          7, colorForType(7),
          8, colorForType(8),
          9, colorForType(9),
          10, colorForType(10),
          11, colorForType(11),
          12, colorForType(12),
          colorForType(3),
        ],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
      },
    });
  }
}

export function addDeltaPinLayers(map: maplibregl.Map, sourceId = "pins-delta"): void {
  const layerId = `${sourceId}-circles`;
  if (map.getLayer(layerId)) return;
  map.addLayer({
    id: layerId,
    type: "circle",
    source: sourceId,
    paint: {
      "circle-radius": 7,
      "circle-color": "#fbbf24",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });
}

export function setTypeFilter(map: maplibregl.Map, layerId: string, types: number[] | null): void {
  if (!map.getLayer(layerId)) return;
  if (!types || types.length === 0) {
    map.setFilter(layerId, null);
    return;
  }
  map.setFilter(layerId, ["in", ["get", "t"], ["literal", types]] as maplibregl.FilterSpecification);
}

export function applyEnrichmentFeatureState(
  map: maplibregl.Map,
  sourceId: string,
  pins: Array<{ id: string; rating?: number | null; reviews?: number; attrs0?: number; attrs1?: number }>,
): void {
  for (const p of pins) {
    map.setFeatureState(
      { source: sourceId, sourceLayer: "pins", id: p.id },
      {
        rating: p.rating ?? 0,
        reviews: p.reviews ?? 0,
        attrs0: p.attrs0 ?? 0,
        attrs1: p.attrs1 ?? 0,
      },
    );
  }
}
