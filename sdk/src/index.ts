import type maplibregl from "maplibre-gl";
import type { P5nConfig } from "../types";
import { fetchPlaceDetail } from "./detail/place-detail";
import { scheduleViewportEnrich } from "./enrich/viewport-enrich";
import { addDeltaPinLayers, addPinLayers } from "./layers/pins";
import {
  addDeltaGeoJsonSource,
  addPinsVectorSource,
  createMap,
  fetchTileManifest,
  pinsPmtilesUrl,
  registerPmtilesProtocol,
  upsertDeltaPin,
} from "./map-core";
import { downloadPinsPmtiles, getOfflineTilesUrl, hasOfflineTiles, saveOfflineManifest } from "./offline/opfs";
import { streamSearch } from "./search/streaming-search";
import { setMapTheme, watchTheme } from "./theme/theme";

export class P5nMap {
  readonly map: maplibregl.Map;
  readonly config: P5nConfig;
  private pinsSourceId = "pins-baked";
  private styleReady = false;
  private layerAttach?: () => void;
  dark: boolean;

  constructor(container: HTMLElement, config: P5nConfig) {
    this.config = config;
    this.dark = config.dark ?? true;
    registerPmtilesProtocol();
    this.map = createMap(container, config);
    this.map.on("load", () => {
      this.styleReady = true;
      void this.attachSources();
    });
  }

  private async attachSources(): Promise<void> {
    const url = pinsPmtilesUrl(this.config);
    if (url) {
      addPinsVectorSource(this.map, this.pinsSourceId, url);
      addPinLayers(this.map, this.pinsSourceId);
    }
    addDeltaGeoJsonSource(this.map);
    addDeltaPinLayers(this.map);
    this.layerAttach = () => {
      if (url) {
        if (!this.map.getSource(this.pinsSourceId)) {
          addPinsVectorSource(this.map, this.pinsSourceId, url);
          addPinLayers(this.map, this.pinsSourceId);
        }
      }
      addDeltaGeoJsonSource(this.map);
      addDeltaPinLayers(this.map);
    };
  }

  async initTilesFromManifest(): Promise<void> {
    try {
      const manifest = await fetchTileManifest(this.config.apiBase);
      if (manifest.url) {
        this.config.tilesUrl = manifest.url.startsWith("pmtiles://")
          ? manifest.url
          : `pmtiles://${manifest.url}`;
        if (this.styleReady) await this.attachSources();
      }
    } catch {
      /* no baked tiles yet */
    }
  }

  async tryOfflineFirst(): Promise<boolean> {
    if (!(await hasOfflineTiles())) return false;
    const blobUrl = await getOfflineTilesUrl();
    if (!blobUrl) return false;
    this.config.offlineTilesPath = blobUrl;
    this.config.tilesUrl = null;
    if (this.styleReady) await this.attachSources();
    return true;
  }

  watchSystemTheme(): () => void {
    return watchTheme(this.map, (d) => {
      this.dark = d;
      setMapTheme(this.map, d, this.layerAttach);
    });
  }

  onMoveEndEnrich(since?: string): void {
    this.map.on("moveend", () => {
      scheduleViewportEnrich(this.map, this.config.apiBase, this.pinsSourceId, since);
    });
  }

  addLivePin(pin: { id: string; lat: number; lng: number; t: number; name?: string | null }): void {
    upsertDeltaPin(this.map, pin);
  }

  connectLiveStream(onStats?: (stats: unknown) => void): EventSource {
    const es = new EventSource(`${this.config.apiBase}/api/stream`);
    es.addEventListener("place", (ev) => {
      const pin = JSON.parse((ev as MessageEvent).data);
      this.addLivePin(pin);
    });
    es.addEventListener("stats", (ev) => onStats?.(JSON.parse((ev as MessageEvent).data)));
    return es;
  }

  async search(opts: Parameters<typeof streamSearch>[1]): Promise<ReturnType<typeof streamSearch>> {
    return streamSearch(this.config.apiBase, opts);
  }

  async placeDetail(placeId: string): Promise<unknown> {
    return fetchPlaceDetail(this.config.apiBase, placeId);
  }

  async downloadOffline(onProgress?: (pct: number) => void): Promise<void> {
    const manifest = await fetchTileManifest(this.config.apiBase);
    if (!manifest.url) throw new Error("No baked tiles available yet");
    await downloadPinsPmtiles(manifest.url, onProgress);
    await saveOfflineManifest(manifest);
  }

  onPinClick(handler: (placeId: string, feature: maplibregl.MapGeoJSONFeature) => void): void {
    for (const layerId of [`${this.pinsSourceId}-circles`, `${this.pinsSourceId}-symbols`, "pins-delta-circles"]) {
      this.map.on("click", layerId, (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = String(f.properties?.id ?? f.id ?? "");
        if (id) handler(id, f);
      });
      this.map.on("mouseenter", layerId, () => {
        this.map.getCanvas().style.cursor = "pointer";
      });
      this.map.on("mouseleave", layerId, () => {
        this.map.getCanvas().style.cursor = "";
      });
    }
  }
}

export * from "./colors";
export * from "./types";
export { streamSearch, fetchPlaceDetail, downloadPinsPmtiles, hasOfflineTiles };
