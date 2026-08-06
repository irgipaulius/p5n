import type maplibregl from "maplibre-gl";
import { ALL_TYPE_INTS, colorForType } from "../colors";
import { iconImageExpression } from "../icons/pin-icons";

const TYPE_NUM = ["to-number", ["get", "t"]] as maplibregl.ExpressionSpecification;

function typeColorMatch(): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ["match", TYPE_NUM];
  for (const t of ALL_TYPE_INTS) {
    expr.push(t, colorForType(t));
  }
  expr.push(colorForType(3));
  return expr as maplibregl.ExpressionSpecification;
}

/** Circle + symbol layers for a geojson pin source. */
export function addGeoJsonPinLayers(map: maplibregl.Map, sourceId: string): void {
  const circleId = `${sourceId}-circles`;
  const symbolId = `${sourceId}-symbols`;

  if (!map.getLayer(circleId)) {
    map.addLayer({
      id: circleId,
      type: "circle",
      source: sourceId,
      minzoom: 0,
      maxzoom: 11.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 8, 6, 12, 8],
        "circle-color": typeColorMatch(),
        "circle-stroke-width": 2,
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
      minzoom: 11.5,
      layout: {
        "icon-image": iconImageExpression(),
        "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.7, 16, 1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }
}

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
      maxzoom: 11.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 8, 6, 12, 8],
        "circle-color": typeColorMatch(),
        "circle-stroke-width": 2,
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
      minzoom: 11.5,
      layout: {
        "icon-image": iconImageExpression(),
        "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.7, 16, 1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }
}

export function addDeltaPinLayers(map: maplibregl.Map, sourceId = "pins-delta"): void {
  addGeoJsonPinLayers(map, sourceId);
}

export function deltaLayerIds(deltaId = "pins-delta"): string[] {
  return [`${deltaId}-circles`, `${deltaId}-symbols`];
}

export function baseLayerIds(sourceId = "pins-baked", deltaId = "pins-delta"): string[] {
  return [
    `${sourceId}-circles`,
    `${sourceId}-symbols`,
    ...deltaLayerIds(deltaId),
  ];
}

export function filteredLayerIds(filteredId = "pins-filtered"): string[] {
  return [`${filteredId}-circles`, `${filteredId}-symbols`];
}

export function clickableLayerIds(
  sourceId = "pins-baked",
  deltaId = "pins-delta",
  filteredId = "pins-filtered",
): string[] {
  return [...baseLayerIds(sourceId, deltaId), ...filteredLayerIds(filteredId)];
}

export function allPinLayerIds(sourceId = "pins-baked", deltaId = "pins-delta", filteredId = "pins-filtered"): string[] {
  return clickableLayerIds(sourceId, deltaId, filteredId);
}

export function setLayerVisibility(map: maplibregl.Map, layerIds: string[], visible: boolean): void {
  for (const id of layerIds) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}

export function setTypeFilter(map: maplibregl.Map, types: number[] | null, layerIds: string[]): void {
  let filter: maplibregl.FilterSpecification | null = null;
  if (types && types.length === 0) {
    filter = ["==", ["literal", 1], 0];
  } else if (types && types.length > 0) {
    filter = ["in", TYPE_NUM, ["literal", types]];
  }
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

const SELECTED_SOURCE = "pins-selected";

/** Highlight ring + icon for the actively selected pin (always on top). */
export function ensureSelectedPinLayer(map: maplibregl.Map): void {
  if (!map.getSource(SELECTED_SOURCE)) {
    map.addSource(SELECTED_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer(`${SELECTED_SOURCE}-halo`)) {
    map.addLayer({
      id: `${SELECTED_SOURCE}-halo`,
      type: "circle",
      source: SELECTED_SOURCE,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 14, 10, 18, 14, 24],
        "circle-color": "#38bdf8",
        "circle-opacity": 0.35,
        "circle-stroke-width": 3,
        "circle-stroke-color": "#e0f2fe",
        "circle-stroke-opacity": 0.95,
      },
    });
  }
  if (!map.getLayer(`${SELECTED_SOURCE}-icon`)) {
    map.addLayer({
      id: `${SELECTED_SOURCE}-icon`,
      type: "symbol",
      source: SELECTED_SOURCE,
      layout: {
        "icon-image": iconImageExpression(),
        "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 1.1, 10, 1.35, 14, 1.6],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }
}

export function setSelectedPinFeature(
  map: maplibregl.Map,
  pin: { id: string; lat: number; lng: number; t: number } | null,
): void {
  ensureSelectedPinLayer(map);
  const src = map.getSource(SELECTED_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  if (!pin) {
    src.setData({ type: "FeatureCollection", features: [] });
    return;
  }
  src.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: pin.id,
        geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
        properties: { id: pin.id, t: pin.t, name: "" },
      },
    ],
  });
}
