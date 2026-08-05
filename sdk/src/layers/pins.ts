import type maplibregl from "maplibre-gl";
import { colorForType } from "../colors";
import { iconImageExpression } from "../icons/pin-icons";

const MATCH_T = ["get", "t"] as maplibregl.ExpressionSpecification;

export function addPinLayers(
  map: maplibregl.Map,
  sourceId: string,
  opts: { circleLayerId?: string; symbolLayerId?: string; sourceLayer?: string } = {},
): void {
  const circleId = opts.circleLayerId ?? `${sourceId}-circles`;
  const symbolId = opts.symbolLayerId ?? `${sourceId}-symbols`;
  const sourceLayer = opts.sourceLayer ?? "pins";

  if (!map.getLayer(circleId)) {
    map.addLayer({
      id: circleId,
      type: "circle",
      source: sourceId,
      "source-layer": sourceLayer,
      minzoom: 0,
      maxzoom: 11,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 8, 5, 11, 7],
        "circle-color": typeColorMatch(),
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#0f172a",
        "circle-opacity": 0.95,
      },
    });
  }

  if (!map.getLayer(symbolId)) {
    map.addLayer({
      id: symbolId,
      type: "symbol",
      source: sourceId,
      "source-layer": sourceLayer,
      minzoom: 11,
      layout: {
        "icon-image": iconImageExpression(),
        "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.65, 16, 1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }
}

export function addDeltaPinLayers(map: maplibregl.Map, sourceId = "pins-delta"): void {
  const circleId = `${sourceId}-circles`;
  const symbolId = `${sourceId}-symbols`;

  if (!map.getLayer(circleId)) {
    map.addLayer({
      id: circleId,
      type: "circle",
      source: sourceId,
      minzoom: 0,
      maxzoom: 11,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 11, 8],
        "circle-color": typeColorMatch(),
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
        "circle-opacity": 0.95,
      },
    });
  }

  if (!map.getLayer(symbolId)) {
    map.addLayer({
      id: symbolId,
      type: "symbol",
      source: sourceId,
      minzoom: 11,
      layout: {
        "icon-image": iconImageExpression(),
        "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.7, 16, 1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }
}

function typeColorMatch(): maplibregl.ExpressionSpecification {
  return [
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
  ];
}

export function allPinLayerIds(sourceId = "pins-baked", deltaId = "pins-delta"): string[] {
  return [
    `${sourceId}-circles`,
    `${sourceId}-symbols`,
    `${deltaId}-circles`,
    `${deltaId}-symbols`,
    "search-results-circles",
    "search-results-symbols",
  ];
}

export function setTypeFilter(map: maplibregl.Map, types: number[] | null, layerIds: string[]): void {
  const filter =
    !types || types.length === 0
      ? null
      : (["in", ["get", "t"], ["literal", types]] as maplibregl.FilterSpecification);
  for (const id of layerIds) {
    if (map.getLayer(id)) map.setFilter(id, filter);
  }
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
