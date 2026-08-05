import type maplibregl from "maplibre-gl";
import type { P5nConfig, PinFeature } from "./types";
import { fetchPlaceDetail } from "./detail/place-detail";
import { scheduleViewportEnrich } from "./enrich/viewport-enrich";
import { addDeltaPinLayers, addPinLayers, allPinLayerIds, setTypeFilter } from "./layers/pins";
import { registerPinIcons, iconImageExpression } from "./icons/pin-icons";
import {
  addDeltaGeoJsonSource,
  addPinsVectorSource,
  createMap,
  fetchTileManifest,
  pinsPmtilesUrl,
  registerPmtilesProtocol,
} from "./map-core";
import { downloadPinsPmtiles, getOfflineTilesUrl, hasOfflineTiles, saveOfflineManifest } from "./offline/opfs";
import { streamSearch } from "./search/streaming-search";
import { setMapTheme, watchTheme } from "./theme/theme";

export class P5nMap {
  readonly map: maplibregl.Map;
  readonly config: P5nConfig;
  private pinsSourceId = "pins-baked";
  private deltaSourceId = "pins-delta";
  private deltaFeatures: GeoJSON.Feature[] = [];
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
      this.flushDeltaPins();
    });
  }

  private searchFeatures: GeoJSON.Feature[] = [];

  private async attachSources(): Promise<void> {
    await registerPinIcons(this.map);
    const url = pinsPmtilesUrl(this.config);
    if (url) {
      addPinsVectorSource(this.map, this.pinsSourceId, url);
      addPinLayers(this.map, this.pinsSourceId);
    }
    this.ensureDeltaLayer();
    this.layerAttach = () => {
      if (url && !this.map.getSource(this.pinsSourceId)) {
        addPinsVectorSource(this.map, this.pinsSourceId, url);
        addPinLayers(this.map, this.pinsSourceId);
      }
      this.ensureDeltaLayer();
      this.flushDeltaPins();
    };
  }

  private ensureDeltaLayer(): void {
    if (!this.map.isStyleLoaded()) return;
    void registerPinIcons(this.map).then(() => {
      addDeltaGeoJsonSource(this.map, this.deltaSourceId);
      addDeltaPinLayers(this.map, this.deltaSourceId);
      this.ensureSearchLayer();
      this.flushDeltaPins();
      this.flushSearchResults();
    });
  }

  private ensureSearchLayer(): void {
    if (!this.map.getSource("search-results")) {
      this.map.addSource("search-results", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      this.map.addLayer({
        id: "search-results-symbols",
        type: "symbol",
        source: "search-results",
        layout: {
          "icon-image": iconImageExpression(),
          "icon-size": 1,
          "icon-allow-overlap": true,
        },
      });
    }
  }

  private flushDeltaPins(): void {
    const src = this.map.getSource(this.deltaSourceId) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: [...this.deltaFeatures] });
  }

  async loadExistingPins(): Promise<number> {
    const resp = await fetch(`${this.config.apiBase}/api/places/geo`);
    if (!resp.ok) return 0;
    const pins = (await resp.json()) as PinFeature[];
    for (const pin of pins) this.addLivePin(pin);
    if (pins.length > 0) {
      const lngs = pins.map((p) => p.lng);
      const lats = pins.map((p) => p.lat);
      const bounds: maplibregl.LngLatBoundsLike = [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ];
      this.map.fitBounds(bounds, { padding: 60, maxZoom: 10, duration: 0 });
    }
    return pins.length;
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
    const idx = this.deltaFeatures.findIndex((f) => String(f.properties?.id) === pin.id);
    const feature: GeoJSON.Feature = {
      type: "Feature",
      id: pin.id,
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: { id: pin.id, t: pin.t, name: pin.name ?? "" },
    };
    if (idx >= 0) this.deltaFeatures[idx] = feature;
    else this.deltaFeatures.push(feature);
    this.flushDeltaPins();
  }

  connectLiveStream(onStats?: (stats: unknown) => void, onPin?: (pin: PinFeature) => void): EventSource {
    const es = new EventSource(`${this.config.apiBase}/api/stream`);
    es.addEventListener("place", (ev) => {
      const pin = JSON.parse((ev as MessageEvent).data) as PinFeature;
      this.addLivePin(pin);
      onPin?.(pin);
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

  filterTypes(types: number[] | null): void {
    setTypeFilter(this.map, types, allPinLayerIds(this.pinsSourceId, this.deltaSourceId));
  }

  setSearchResults(pins: PinFeature[]): void {
    this.searchFeatures = pins.map((pin) => ({
      type: "Feature" as const,
      id: pin.id,
      geometry: { type: "Point" as const, coordinates: [pin.lng, pin.lat] },
      properties: { id: pin.id, t: pin.t, name: pin.name ?? "" },
    }));
    this.flushSearchResults();
  }

  clearSearchResults(): void {
    this.searchFeatures = [];
    this.flushSearchResults();
  }

  private flushSearchResults(): void {
    const src = this.map.getSource("search-results") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: [...this.searchFeatures] });
  }

  onPinClick(handler: (placeId: string, feature: maplibregl.MapGeoJSONFeature) => void): void {
    for (const layerId of allPinLayerIds(this.pinsSourceId, this.deltaSourceId)) {
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
