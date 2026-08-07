import type maplibregl from "maplibre-gl";
import { viewportBbox } from "./zoom-policy";

export interface GridCell {
  g4: string;
  count: number;
  lat: number;
  lng: number;
}

function cellFeature(c: GridCell): GeoJSON.Feature {
  return {
    type: "Feature",
    id: `grid:${c.g4}`,
    geometry: { type: "Point", coordinates: [c.lng, c.lat] },
    properties: { g4: c.g4, count: c.count, grid: true },
  };
}

function inBbox(
  lng: number,
  lat: number,
  bbox: { west: number; south: number; east: number; north: number },
): boolean {
  return lng >= bbox.west && lng <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

/** Low-zoom loader — one bbox request, stable bubbles while panning. */
export class GridPinLoader {
  private byG4 = new Map<string, GeoJSON.Feature>();
  private fetching = false;
  private gridReady = false;

  constructor(
    private map: maplibregl.Map,
    private apiBase: string,
    private sourceId = "pins-grid",
  ) {}

  isReady(): boolean {
    return this.gridReady;
  }

  visiblePinCount(bbox = viewportBbox(this.map)): number {
    let n = 0;
    for (const f of this.byG4.values()) {
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      if (inBbox(lng, lat, bbox)) n += Number(f.properties?.count ?? 0);
    }
    return n;
  }

  /** Repaint from cache while panning (no network). */
  repaint(): void {
    this.paint(viewportBbox(this.map));
  }

  async sync(): Promise<number> {
    const bbox = viewportBbox(this.map);
    this.paint(bbox);

    if (this.fetching) return this.visiblePinCount(bbox);
    this.fetching = true;

    try {
      const params = new URLSearchParams({
        west: String(bbox.west),
        south: String(bbox.south),
        east: String(bbox.east),
        north: String(bbox.north),
        limit: "400",
      });
      const resp = await fetch(`${this.apiBase}/api/pins/grid?${params}`);
      if (!resp.ok) return this.visiblePinCount(bbox);

      const data = (await resp.json()) as { cells?: GridCell[] };
      for (const c of data.cells ?? []) {
        this.byG4.set(c.g4, cellFeature(c));
      }
      this.gridReady = this.byG4.size > 0;
      this.paint(bbox);
      return this.visiblePinCount(bbox);
    } finally {
      this.fetching = false;
    }
  }

  /** Show every cached cell in the current viewport — never drop cells mid-pan. */
  private paint(bbox: { west: number; south: number; east: number; north: number }): void {
    const features: GeoJSON.Feature[] = [];
    for (const f of this.byG4.values()) {
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      if (inBbox(lng, lat, bbox)) features.push(f);
    }
    const src = this.map.getSource(this.sourceId) as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features });
  }

  clear(): void {
    this.byG4.clear();
    this.gridReady = false;
    const src = this.map.getSource(this.sourceId) as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: [] });
  }
}
