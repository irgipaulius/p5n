import type maplibregl from "maplibre-gl";
import { addGeoJsonPinLayers, PIN_CLUSTER_SOURCE_OPTS, removeGeoJsonPinLayers } from "../layers/pins";
import { chunkIdsForBbox } from "../../../shared/tile-chunks";
import { shouldLoadChunks, viewportBbox } from "./zoom-policy";

export interface ChunkManifestEntry {
  chunk_id: string;
  url: string;
  place_count: number;
  version: number;
  format?: string;
}

export class ChunkTileLoader {
  private loaded = new Set<string>();
  private loading = new Set<string>();

  constructor(
    private map: maplibregl.Map,
    private apiBase: string,
  ) {}

  loadedCount(): number {
    return this.loaded.size;
  }

  async sync(): Promise<number> {
    if (!shouldLoadChunks(this.map)) return 0;

    const ids = chunkIdsForBbox(viewportBbox(this.map));
    const missing = ids.filter((id) => !this.loaded.has(id) && !this.loading.has(id));
    if (missing.length === 0) return 0;

    for (const id of missing) this.loading.add(id);

    try {
      const params = new URLSearchParams({ ids: missing.join(",") });
      const resp = await fetch(`${this.apiBase}/api/tiles/chunks?${params}`);
      if (!resp.ok) return 0;
      const data = (await resp.json()) as { chunks?: ChunkManifestEntry[] };
      let added = 0;
      for (const chunk of data.chunks ?? []) {
        if (this.loaded.has(chunk.chunk_id)) continue;
        const ok = await this.attachChunk(chunk);
        if (ok) {
          this.loaded.add(chunk.chunk_id);
          added += 1;
        }
      }
      return added;
    } finally {
      for (const id of missing) this.loading.delete(id);
    }
  }

  private async attachChunk(chunk: ChunkManifestEntry): Promise<boolean> {
    const sourceId = `pins-chunk-${chunk.chunk_id}`;
    if (this.map.getSource(sourceId)) return true;

    this.map.addSource(sourceId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      promoteId: "id",
      ...PIN_CLUSTER_SOURCE_OPTS,
    });
    addGeoJsonPinLayers(this.map, sourceId);

    const resp = await fetch(chunk.url);
    if (!resp.ok) {
      removeGeoJsonPinLayers(this.map, sourceId);
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
      return false;
    }
    const geojson = (await resp.json()) as GeoJSON.FeatureCollection;
    const src = this.map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    src?.setData(geojson);
    return (geojson.features?.length ?? 0) > 0;
  }

  clear(): void {
    for (const id of [...this.loaded]) {
      const sourceId = `pins-chunk-${id}`;
      removeGeoJsonPinLayers(this.map, sourceId);
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
    }
    this.loaded.clear();
    this.loading.clear();
  }
}
