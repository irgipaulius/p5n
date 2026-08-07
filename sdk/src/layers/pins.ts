import type maplibregl from "maplibre-gl";
import { ALL_TYPE_INTS, colorForType } from "../colors";
import { iconImageExpression } from "../icons/pin-icons";

const TYPE_NUM = ["to-number", ["get", "t"]] as maplibregl.ExpressionSpecification;

/** Shared GeoJSON cluster source options. */
export const PIN_CLUSTER_SOURCE_OPTS = {
  cluster: true as const,
  clusterMaxZoom: 11,
  clusterRadius: 44,
};

function typeColorMatch(): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ["match", TYPE_NUM];
  for (const t of ALL_TYPE_INTS) {
    expr.push(t, colorForType(t));
  }
  expr.push(colorForType(3));
  return expr as maplibregl.ExpressionSpecification;
}

const HEATMAP_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["heatmap-density"],
  0,
  "rgba(15, 23, 42, 0)",
  0.12,
  "rgba(56, 189, 248, 0.18)",
  0.35,
  "rgba(14, 165, 233, 0.42)",
  0.55,
  "rgba(251, 146, 60, 0.48)",
  0.75,
  "rgba(249, 115, 22, 0.58)",
  1,
  "rgba(234, 88, 12, 0.72)",
];

/** All layer ids owned by a geojson pin source. */
export function geoJsonPinLayerIds(sourceId: string): string[] {
  return [
    `${sourceId}-heatmap`,
    `${sourceId}-cluster-glow`,
    `${sourceId}-clusters`,
    `${sourceId}-cluster-count`,
    `${sourceId}-circles`,
    `${sourceId}-symbols`,
  ];
}

export function removeGeoJsonPinLayers(map: maplibregl.Map, sourceId: string): void {
  for (const id of geoJsonPinLayerIds(sourceId)) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
}

const COUNT = ["to-number", ["get", "count"]] as maplibregl.ExpressionSpecification;
const POINT_COUNT = ["to-number", ["coalesce", ["get", "point_count"], 1]] as maplibregl.ExpressionSpecification;
/** Real POI pins carry type `t`; grid/heatmap aggregates do not. */
const PIN_ONLY: maplibregl.FilterSpecification = ["has", "t"];
const NOT_CLUSTER: maplibregl.FilterSpecification = PIN_ONLY;

/** Server-preaggregated grid cells — no client clustering. */
export function gridPinLayerIds(sourceId = "pins-grid"): string[] {
  return [`${sourceId}-heatmap`, `${sourceId}-glow`, `${sourceId}-cells`, `${sourceId}-count`];
}

export function removeGridPinLayers(map: maplibregl.Map, sourceId = "pins-grid"): void {
  for (const id of gridPinLayerIds(sourceId)) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

export function addGridPinLayers(map: maplibregl.Map, sourceId = "pins-grid"): void {
  const heatmapId = `${sourceId}-heatmap`;
  const glowId = `${sourceId}-glow`;
  const cellId = `${sourceId}-cells`;
  const countId = `${sourceId}-count`;

  if (!map.getLayer(heatmapId)) {
    map.addLayer({
      id: heatmapId,
      type: "heatmap",
      source: sourceId,
      maxzoom: 8,
      paint: {
        "heatmap-weight": COUNT,
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 6, 1.4, 8, 2],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 16, 6, 28, 8, 38],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.85, 7, 0.2, 8, 0],
        "heatmap-color": HEATMAP_COLOR,
      },
    });
  }

  if (!map.getLayer(glowId)) {
    map.addLayer({
      id: glowId,
      type: "circle",
      source: sourceId,
      paint: {
        "circle-color": [
          "interpolate",
          ["linear"],
          COUNT,
          1,
          "#38bdf8",
          50,
          "#0ea5e9",
          200,
          "#f97316",
        ],
        "circle-radius": ["step", COUNT, 28, 10, 34, 50, 44, 200, 56, 500, 68],
        "circle-opacity": 0.2,
        "circle-blur": 1,
      },
    });
  }

  if (!map.getLayer(cellId)) {
    map.addLayer({
      id: cellId,
      type: "circle",
      source: sourceId,
      paint: {
        "circle-color": [
          "interpolate",
          ["linear"],
          COUNT,
          1,
          "rgba(56, 189, 248, 0.55)",
          50,
          "rgba(14, 165, 233, 0.62)",
          200,
          "rgba(249, 115, 22, 0.68)",
        ],
        "circle-radius": ["step", COUNT, 16, 10, 20, 50, 28, 200, 36, 500, 44],
        "circle-opacity": 0.72,
        "circle-blur": 0.4,
        "circle-stroke-width": 0,
      },
    });
  }

  if (!map.getLayer(countId)) {
    map.addLayer({
      id: countId,
      type: "symbol",
      source: sourceId,
      layout: {
        "text-field": ["to-string", COUNT],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": ["step", COUNT, 11, 50, 12, 200, 14],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#f0f9ff",
        "text-halo-color": "rgba(15, 23, 42, 0.75)",
        "text-halo-width": 1.5,
      },
    });
  }
}

/** Heatmap + soft clusters + larger pin markers. */
export function addGeoJsonPinLayers(map: maplibregl.Map, sourceId: string, clustered = true): void {
  const heatmapId = `${sourceId}-heatmap`;
  const glowId = `${sourceId}-cluster-glow`;
  const clusterId = `${sourceId}-clusters`;
  const countId = `${sourceId}-cluster-count`;
  const circleId = `${sourceId}-circles`;
  const symbolId = `${sourceId}-symbols`;

  if (clustered && !map.getLayer(heatmapId)) {
    map.addLayer({
      id: heatmapId,
      type: "heatmap",
      source: sourceId,
      maxzoom: 10,
      paint: {
        "heatmap-weight": 1,
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 6, 1.2, 9, 2],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 18, 6, 28, 9, 42],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.9, 9, 0.35, 10, 0],
        "heatmap-color": HEATMAP_COLOR,
      },
    });
  }

  if (clustered && !map.getLayer(glowId)) {
    map.addLayer({
      id: glowId,
      type: "circle",
      source: sourceId,
      filter: ["has", "point_count"],
      minzoom: 0,
      maxzoom: 12,
      paint: {
        "circle-color": [
          "interpolate",
          ["linear"],
          ["get", "point_count"],
          10,
          "#38bdf8",
          100,
          "#0ea5e9",
          500,
          "#f97316",
        ],
        "circle-radius": ["step", ["get", "point_count"], 32, 25, 40, 100, 52, 500, 68],
        "circle-opacity": 0.22,
        "circle-blur": 1,
      },
    });
  }

  if (clustered && !map.getLayer(clusterId)) {
    map.addLayer({
      id: clusterId,
      type: "circle",
      source: sourceId,
      filter: ["has", "point_count"],
      minzoom: 0,
      maxzoom: 12,
      paint: {
        "circle-color": [
          "interpolate",
          ["linear"],
          ["get", "point_count"],
          10,
          "rgba(56, 189, 248, 0.55)",
          100,
          "rgba(14, 165, 233, 0.62)",
          500,
          "rgba(249, 115, 22, 0.68)",
        ],
        "circle-radius": ["step", ["get", "point_count"], 18, 25, 24, 100, 32, 500, 42],
        "circle-opacity": 0.7,
        "circle-blur": 0.45,
        "circle-stroke-width": 0,
      },
    });
  }

  if (clustered && !map.getLayer(countId)) {
    map.addLayer({
      id: countId,
      type: "symbol",
      source: sourceId,
      filter: ["has", "point_count"],
      minzoom: 0,
      maxzoom: 12,
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": ["step", ["get", "point_count"], 11, 100, 13, 500, 15],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#f0f9ff",
        "text-halo-color": "rgba(15, 23, 42, 0.75)",
        "text-halo-width": 1.5,
      },
    });
  }

  if (!map.getLayer(circleId)) {
    map.addLayer({
      id: circleId,
      type: "circle",
      source: sourceId,
      filter: clustered ? ["!", ["has", "point_count"]] : undefined,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 7, 8, 9, 12, 11, 16, 14],
        "circle-color": typeColorMatch(),
        "circle-stroke-width": 2.5,
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
      filter: clustered ? ["!", ["has", "point_count"]] : undefined,
      minzoom: 9,
      layout: {
        "icon-image": iconImageExpression(),
        "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.95, 13, 1.15, 17, 1.45],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }
}

export function vectorPinLayerIds(sourceId = "pins-baked"): string[] {
  return [`${sourceId}-heatmap`, `${sourceId}-circles`, `${sourceId}-symbols`];
}

export function addPinLayers(
  map: maplibregl.Map,
  sourceId: string,
  opts: {
    circleLayerId?: string;
    symbolLayerId?: string;
    heatmapLayerId?: string;
    sourceLayer?: string;
    heatmapOnly?: boolean;
  } = {},
): void {
  const heatmapId = opts.heatmapLayerId ?? `${sourceId}-heatmap`;
  const circleId = opts.circleLayerId ?? `${sourceId}-circles`;
  const symbolId = opts.symbolLayerId ?? `${sourceId}-symbols`;
  const sourceLayer = opts.sourceLayer ?? "pins";
  const heatmapOnly = opts.heatmapOnly ?? false;

  if (!map.getLayer(heatmapId)) {
    map.addLayer({
      id: heatmapId,
      type: "heatmap",
      source: sourceId,
      "source-layer": sourceLayer,
      maxzoom: 12,
      paint: {
        "heatmap-weight": POINT_COUNT,
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 6, 1.2, 10, 2],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 18, 6, 28, 10, 42],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.9, 10, 0.35, 12, 0],
        "heatmap-color": HEATMAP_COLOR,
      },
    });
  }

  if (!heatmapOnly && !map.getLayer(circleId)) {
    map.addLayer({
      id: circleId,
      type: "circle",
      source: sourceId,
      "source-layer": sourceLayer,
      filter: NOT_CLUSTER,
      minzoom: 9,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 7, 8, 9, 12, 11, 16, 14],
        "circle-color": typeColorMatch(),
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#0f172a",
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0, 11, 0.95],
      },
    });
  }

  if (!heatmapOnly && !map.getLayer(symbolId)) {
    map.addLayer({
      id: symbolId,
      type: "symbol",
      source: sourceId,
      "source-layer": sourceLayer,
      filter: NOT_CLUSTER,
      minzoom: 11,
      layout: {
        "icon-image": iconImageExpression(),
        "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.95, 13, 1.15, 17, 1.45],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 12, 1],
      },
    });
  }
}

export function addDeltaPinLayers(map: maplibregl.Map, sourceId = "pins-delta"): void {
  addGeoJsonPinLayers(map, sourceId);
}

export function deltaLayerIds(deltaId = "pins-delta"): string[] {
  return geoJsonPinLayerIds(deltaId);
}

export function baseLayerIds(sourceId = "pins-baked", deltaId = "pins-delta"): string[] {
  return [...vectorPinLayerIds(sourceId), ...deltaLayerIds(deltaId)];
}

export function filteredLayerIds(filteredId = "pins-filtered"): string[] {
  return geoJsonPinLayerIds(filteredId);
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
  let typeFilter: maplibregl.FilterSpecification | null = null;
  if (types && types.length === 0) {
    typeFilter = ["==", ["literal", 1], 0];
  } else if (types && types.length > 0) {
    typeFilter = ["in", TYPE_NUM, ["literal", types]];
  }
  for (const id of layerIds) {
    if (!map.getLayer(id)) continue;
    if (id.endsWith("-heatmap") || id.endsWith("-cluster-glow") || id.endsWith("-clusters") || id.endsWith("-cluster-count")) {
      continue;
    }
    const isVectorPin = id.endsWith("-circles") || id.endsWith("-symbols");
    const baseFilter: maplibregl.FilterSpecification | null = isVectorPin ? PIN_ONLY : null;
    if (baseFilter && typeFilter) {
      map.setFilter(id, ["all", baseFilter, typeFilter]);
    } else if (baseFilter) {
      map.setFilter(id, baseFilter);
    } else {
      map.setFilter(id, typeFilter);
    }
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
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 16, 10, 22, 14, 28],
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
        "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 1.2, 10, 1.45, 14, 1.75],
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
