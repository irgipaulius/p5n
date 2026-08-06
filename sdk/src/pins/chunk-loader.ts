import type maplibregl from "maplibre-gl";
import { chunkIdsForBbox } from "../../../shared/tile-chunks";
import { addPinLayers } from "../layers/pins";
import { addPinsVectorSource } from "../map-core";
import { shouldLoadChunks, viewportBbox } from "./zoom-policy";

export interface ChunkManifestEntry {
  chunk_id: string;
  url: string;
  place_count: number;
  version: number;
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
        this.attachChunk(chunk);
        this.loaded.add(chunk.chunk_id);
        added += 1;
      }
      return added;
    } finally {
      for (const id of missing) this.loading.delete(id);
    }
  }

  private attachChunk(chunk: ChunkManifestEntry): void {
    const sourceId = `pins-chunk-${chunk.chunk_id}`;
    const url = chunk.url.startsWith("pmtiles://") ? chunk.url : `pmtiles://${chunk.url}`;
    addPinsVectorSource(this.map, sourceId, url);
    addPinLayers(this.map, sourceId);
  }

  clear(): void {
    for (const id of [...this.loaded]) {
      const sourceId = `pins-chunk-${id}`;
      for (const layerId of [`${sourceId}-circles`, `${sourceId}-symbols`]) {
        if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
      }
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
    }
    this.loaded.clear();
    this.loading.clear();
  }
}
