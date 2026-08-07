import maplibregl from "maplibre-gl";
import type { Map as MaplibreMap, GeoJSONSource } from "maplibre-gl";
import { geohash4Bbox } from "./geohash";

/** Layers that accept pin / cluster / grid clicks. */
export function interactivePinLayerIds(map: MaplibreMap): string[] {
  return (map.getStyle()?.layers ?? [])
    .map((l) => l.id)
    .filter((id) => {
      if (!id.startsWith("pins-") || id.endsWith("-heatmap")) return false;
      if (id.startsWith("pins-selected")) return id === "pins-selected-icon";
      return (
        id.endsWith("-circles") ||
        id.endsWith("-symbols") ||
        id.endsWith("-clusters") ||
        id.endsWith("-cluster-glow") ||
        id.endsWith("-cluster-count") ||
        id.endsWith("-cells") ||
        id.endsWith("-glow") ||
        id.endsWith("-count")
      );
    });
}

/** How far we're willing to zoom when fitting a cluster — small counts → individual pins. */
function maxZoomForCluster(count: number): number {
  if (count <= 8) return 18;
  if (count <= 20) return 17;
  if (count <= 50) return 16;
  if (count <= 150) return 14;
  if (count <= 500) return 12;
  return 11;
}

async function clusterLeafFeatures(
  src: GeoJSONSource,
  clusterId: number,
  pointCount: number,
): Promise<GeoJSON.Feature[]> {
  const batch = 500;
  const leaves: GeoJSON.Feature[] = [];
  for (let offset = 0; offset < pointCount; offset += batch) {
    const chunk = await src.getClusterLeaves(clusterId, Math.min(batch, pointCount - offset), offset);
    leaves.push(...chunk);
    if (chunk.length === 0) break;
  }
  return leaves;
}

function boundsForPoints(coords: [number, number][]): maplibregl.LngLatBounds {
  const bounds = new maplibregl.LngLatBounds();
  for (const c of coords) bounds.extend(c);

  // Degenerate cluster (stacked pins) — give a minimum span so fitBounds actually zooms in.
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const minSpan = 0.0012;
  const lngSpan = ne.lng - sw.lng;
  const latSpan = ne.lat - sw.lat;
  if (lngSpan < minSpan || latSpan < minSpan) {
    const lng = (ne.lng + sw.lng) / 2;
    const lat = (ne.lat + sw.lat) / 2;
    bounds.extend([lng - minSpan / 2, lat - minSpan / 2]);
    bounds.extend([lng + minSpan / 2, lat + minSpan / 2]);
  }
  return bounds;
}

/** Fit the map to every pin in this cluster — tight for 5, regional for 1k. */
async function zoomToCluster(
  map: MaplibreMap,
  src: GeoJSONSource,
  clusterId: number,
  pointCount: number,
  fallbackCenter: [number, number],
): Promise<void> {
  const count = Math.max(1, pointCount);
  let coords: [number, number][] = [];

  try {
    const leaves = await clusterLeafFeatures(src, clusterId, count);
    for (const leaf of leaves) {
      if (leaf.geometry.type === "Point") {
        coords.push(leaf.geometry.coordinates as [number, number]);
      }
    }
  } catch {
    /* fall through to expansion zoom */
  }

  if (coords.length === 0) {
    const zoom = await src.getClusterExpansionZoom(clusterId);
    map.easeTo({ center: fallbackCenter, zoom: Math.min(zoom + 1, 18), duration: 450 });
    return;
  }

  if (coords.length === 1) {
    map.easeTo({
      center: coords[0],
      zoom: Math.max(map.getZoom() + 2, 15),
      duration: 450,
    });
    return;
  }

  const bounds = boundsForPoints(coords);
  map.fitBounds(bounds, {
    padding: { top: 90, bottom: 90, left: 90, right: 90 },
    maxZoom: maxZoomForCluster(count),
    duration: 500,
  });
}

export function registerPinInteractions(
  map: MaplibreMap,
  handler: (pin: { id: string; lat: number; lng: number; t: number }) => void,
): void {
  map.on("click", (e) => {
    const layers = interactivePinLayerIds(map);
    if (layers.length === 0) return;

    const features = map.queryRenderedFeatures(e.point, { layers });
    if (features.length === 0) return;

    const f = features[0];
    const props = f.properties ?? {};

    if (props.cluster_id != null) {
      const layer = map.getLayer(f.layer.id);
      const sourceId = layer && "source" in layer ? (layer.source as string) : null;
      if (!sourceId || f.geometry.type !== "Point") return;
      const src = map.getSource(sourceId) as GeoJSONSource | undefined;
      if (!src?.getClusterLeaves) return;
      const clusterId = Number(props.cluster_id);
      const pointCount = Number(props.point_count ?? 1);
      const center = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      void zoomToCluster(map, src, clusterId, pointCount, center);
      return;
    }

    if (props.grid && props.g4) {
      const bbox = geohash4Bbox(String(props.g4));
      const count = Number(props.count ?? 1);
      map.fitBounds(
        [
          [bbox.west, bbox.south],
          [bbox.east, bbox.north],
        ],
        {
          padding: 72,
          maxZoom: maxZoomForCluster(count),
          duration: 500,
        },
      );
      return;
    }

    if (props.point_count != null || props.count != null) return;

    const id = String(props.id ?? f.id ?? "");
    if (!id || f.geometry.type !== "Point") return;
    const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
    handler({ id, lat, lng, t: Number(props.t ?? 3) });
  });

  map.on("mousemove", (e) => {
    const layers = interactivePinLayerIds(map);
    if (layers.length === 0) {
      map.getCanvas().style.cursor = "";
      return;
    }
    const hit = map.queryRenderedFeatures(e.point, { layers }).length > 0;
    map.getCanvas().style.cursor = hit ? "pointer" : "";
  });
}
