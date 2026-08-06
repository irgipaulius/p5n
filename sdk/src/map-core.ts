import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { P5nConfig } from "./types";

let protocolRegistered = false;

export function registerPmtilesProtocol(): Protocol {
  if (!protocolRegistered) {
    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    protocolRegistered = true;
    return protocol;
  }
  return new Protocol();
}

/** Vector basemaps — sharp at every zoom; landcover/roads/water are styled, not flat grey. */
const BASEMAP_DARK =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const BASEMAP_LIGHT =
  "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

export function basemapStyle(dark: boolean): string {
  return dark ? BASEMAP_DARK : BASEMAP_LIGHT;
}

export function pinsPmtilesUrl(config: P5nConfig): string | null {
  if (config.offlineTilesPath) {
    return `pmtiles://${config.offlineTilesPath}`;
  }
  if (config.tilesUrl) {
    return config.tilesUrl.startsWith("pmtiles://")
      ? config.tilesUrl
      : `pmtiles://${config.tilesUrl}`;
  }
  return null;
}

export async function fetchTileManifest(apiBase: string): Promise<{
  version: number;
  url: string | null;
  place_count: number;
}> {
  const resp = await fetch(`${apiBase}/api/tiles/manifest`);
  if (!resp.ok) throw new Error(`manifest ${resp.status}`);
  return resp.json();
}

export function createMap(container: HTMLElement, config: P5nConfig): maplibregl.Map {
  registerPmtilesProtocol();
  return new maplibregl.Map({
    container,
    style: basemapStyle(config.dark ?? true),
    center: [10, 50],
    zoom: 5,
    maxPitch: 60,
    antialias: false,
    fadeDuration: 0,
  });
}

export function addPinsVectorSource(
  map: maplibregl.Map,
  sourceId: string,
  pmtilesUrl: string,
): void {
  if (map.getSource(sourceId)) return;
  map.addSource(sourceId, {
    type: "vector",
    url: pmtilesUrl,
    promoteId: "id",
  });
}

export function addDeltaGeoJsonSource(map: maplibregl.Map, sourceId = "pins-delta"): void {
  if (map.getSource(sourceId)) return;
  map.addSource(sourceId, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    promoteId: "id",
    cluster: true,
    clusterMaxZoom: 11,
    clusterRadius: 48,
  });
}

export function upsertDeltaPin(
  map: maplibregl.Map,
  pin: { id: string; lat: number; lng: number; t: number; name?: string | null },
  sourceId = "pins-delta",
): void {
  const src = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  const data = (src as unknown as { _data?: GeoJSON.FeatureCollection })._data ?? {
    type: "FeatureCollection" as const,
    features: [] as GeoJSON.Feature[],
  };
  const features = [...data.features];
  const idx = features.findIndex((f) => String(f.properties?.id) === pin.id);
  const feature: GeoJSON.Feature = {
    type: "Feature",
    id: pin.id,
    geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
    properties: { id: pin.id, t: pin.t, name: pin.name ?? "" },
  };
  if (idx >= 0) features[idx] = feature;
  else features.push(feature);
  src.setData({ type: "FeatureCollection", features });
}
