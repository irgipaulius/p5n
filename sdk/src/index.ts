import type maplibregl from "maplibre-gl";
import type { P5nConfig, PinFeature } from "./types";
import { fetchPlaceDetail } from "./detail/place-detail";
import { scheduleViewportEnrich } from "./enrich/viewport-enrich";
import { addDeltaPinLayers, addGeoJsonPinLayers, addPinLayers, baseLayerIds, clickableLayerIds, filteredLayerIds, setLayerVisibility, setTypeFilter } from "./layers/pins";
import { registerPinIcons } from "./icons/pin-icons";
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

  private layersReady: Promise<void>;
  private resolveLayersReady!: () => void;

  constructor(container: HTMLElement, config: P5nConfig) {
    this.config = config;
    this.dark = config.dark ?? true;
    this.layersReady = new Promise((resolve) => {
      this.resolveLayersReady = resolve;
    });
    registerPmtilesProtocol();
    this.map = createMap(container, config);
    this.map.on("load", () => {
      this.styleReady = true;
      void this.attachSources().then(() => this.resolveLayersReady());
    });
  }

  private filteredSourceId = "pins-filtered";
  private filterMode = false;
  private activeTypeFilter: number[] | null = null;

  private filteredFeatures: GeoJSON.Feature[] = [];

  private async attachSources(): Promise<void> {
    await registerPinIcons(this.map);
    const url = pinsPmtilesUrl(this.config);
    if (url) {
      addPinsVectorSource(this.map, this.pinsSourceId, url);
      addPinLayers(this.map, this.pinsSourceId);
    }
    await this.ensureDeltaLayer();
    this.layerAttach = () => {
      void this.attachSources();
    };
  }

  /** Wait until pin sources/layers are on the map. */
  whenReady(): Promise<void> {
    return this.layersReady;
  }

  private async ensureDeltaLayer(): Promise<void> {
    if (!this.map.isStyleLoaded()) return;
    await registerPinIcons(this.map);
    addDeltaGeoJsonSource(this.map, this.deltaSourceId);
    addDeltaPinLayers(this.map, this.deltaSourceId);
    this.ensureFilteredLayer();
    this.flushDeltaPins();
    this.flushFilteredPins();
    this.applyVisibilityState();
  }

  private ensureFilteredLayer(): void {
    if (!this.map.getSource(this.filteredSourceId)) {
      this.map.addSource(this.filteredSourceId, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      addGeoJsonPinLayers(this.map, this.filteredSourceId);
    }
  }

  private applyVisibilityState(): void {
    setLayerVisibility(this.map, baseLayerIds(this.pinsSourceId, this.deltaSourceId), !this.filterMode);
    setLayerVisibility(this.map, filteredLayerIds(this.filteredSourceId), this.filterMode);
    if (this.activeTypeFilter && !this.filterMode) {
      this.filterTypes(this.activeTypeFilter);
    } else if (this.activeTypeFilter && this.filterMode) {
      setTypeFilter(this.map, this.activeTypeFilter, filteredLayerIds(this.filteredSourceId));
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
    return watchTheme(
      this.map,
      (d) => {
        this.dark = d;
        setMapTheme(this.map, d, () => void this.attachSources());
      },
      () => void this.attachSources(),
      { skipInitial: true },
    );
  }

  onMoveEndEnrich(since?: string): void {
    this.map.on("moveend", () => {
      scheduleViewportEnrich(this.map, this.config.apiBase, this.pinsSourceId, since);
    });
  }

  addLivePin(pin: { id: string; lat: number; lng: number; t: number; name?: string | null }): void {
    const t = Number(pin.t) || 3;
    const idx = this.deltaFeatures.findIndex((f) => String(f.properties?.id) === pin.id);
    const feature: GeoJSON.Feature = {
      type: "Feature",
      id: pin.id,
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: { id: pin.id, t, name: pin.name ?? "" },
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
    this.activeTypeFilter = types;
    const layers = this.filterMode
      ? filteredLayerIds(this.filteredSourceId)
      : baseLayerIds(this.pinsSourceId, this.deltaSourceId);
    setTypeFilter(this.map, types, layers);
  }

  isFilterMode(): boolean {
    return this.filterMode;
  }

  private pinFeature(pin: PinFeature): GeoJSON.Feature {
    const t = Number(pin.t) || 3;
    return {
      type: "Feature",
      id: pin.id,
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: { id: pin.id, t, name: pin.name ?? "" },
    };
  }

  private flushFilteredPins(): void {
    const src = this.map.getSource(this.filteredSourceId) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: [...this.filteredFeatures] });
  }

  /** Show only matching pins (search / feature filter). Hides the full set. */
  showFilteredPins(pins: PinFeature[]): void {
    this.filterMode = true;
    this.filteredFeatures = pins.map((p) => this.pinFeature(p));
    this.flushFilteredPins();
    this.applyVisibilityState();
    if (this.activeTypeFilter) {
      setTypeFilter(this.map, this.activeTypeFilter, filteredLayerIds(this.filteredSourceId));
    }
  }

  clearFilteredPins(): void {
    this.filterMode = false;
    this.filteredFeatures = [];
    this.flushFilteredPins();
    this.applyVisibilityState();
  }

  onPinClick(handler: (placeId: string) => void): void {
    const layers = clickableLayerIds(this.pinsSourceId, this.deltaSourceId, this.filteredSourceId);
    for (const layerId of layers) {
      this.map.on("click", layerId, (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = String(f.properties?.id ?? f.id ?? "");
        if (id) handler(id);
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
export { typeIconSvg, attrIcon, ATTR_ICONS } from "./icons/pin-icons";
export * from "./types";
export { streamSearch, fetchPlaceDetail, downloadPinsPmtiles, hasOfflineTiles };
