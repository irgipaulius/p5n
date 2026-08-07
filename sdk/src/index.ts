import type maplibregl from "maplibre-gl";
import type { P5nConfig, PinFeature } from "./types";
import { fetchPlaceDetail } from "./detail/place-detail";
import { scheduleViewportEnrich } from "./enrich/viewport-enrich";
import { resolveInitialView, type InitialView, type InitialViewOptions } from "./geo/initial-view";
import { addGeoJsonPinLayers, addGridPinLayers, addPinLayers, baseLayerIds, bboxPinLayerIds, deltaLayerIds, filteredLayerIds, gridPinLayerIds, PIN_CLUSTER_SOURCE_OPTS, removeGeoJsonPinLayers, removeGridPinLayers, setLayerVisibility, setSelectedPinFeature, setTypeFilter, vectorPinLayerIds } from "./layers/pins";
import { registerPinInteractions } from "./pin-interactions";
import { expandedBbox, pinInBbox, syncViewportPins, shouldFetchPins, shouldUseGrid } from "./pins/viewport-pins";
import { PinSessionCache } from "./pins/pin-cache";
import { GridPinLoader } from "./pins/grid-loader";
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
  private gridSourceId = "pins-grid";
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
    this.gridLoader = new GridPinLoader(this.map, config.apiBase, this.gridSourceId);
    this.map.on("load", () => {
      this.styleReady = true;
      if (!this.attachDeferred) void this.finishAttach();
    });
  }

  private filteredSourceId = "pins-filtered";
  private filterMode = false;
  private activeTypeFilter: number[] | null = null;
  private selectedPin: { id: string; lat: number; lng: number; t: number } | null = null;

  private filteredFeatures: GeoJSON.Feature[] = [];
  private pinCache = new PinSessionCache();
  private gridLoader!: GridPinLoader;
  private gridAvailable = false;
  private useBakedTiles = false;
  private deltaFeatureCount = -1;
  private attachDeferred = true;
  private attachStarted = false;

  private finishAttach(): Promise<void> {
    if (this.attachStarted) return this.layersReady;
    this.attachStarted = true;
    return this.attachSources().then(() => this.resolveLayersReady());
  }

  private pmtilesActive(): boolean {
    return this.useBakedTiles && pinsPmtilesUrl(this.config) != null;
  }

  /** Zoomed out: heatmap. Zoomed in: bbox pins. */
  private zoomedIn(): boolean {
    return !shouldUseGrid(this.map);
  }

  private tearDownGridLayers(): void {
    this.gridLoader.clear();
    removeGridPinLayers(this.map, this.gridSourceId);
  }

  private async ensureViewportPinLayers(): Promise<void> {
    if (!this.map.isStyleLoaded()) return;
    await registerPinIcons(this.map);
    if (this.pmtilesActive()) {
      if (!this.map.getSource(this.deltaSourceId)) {
        addDeltaGeoJsonSource(this.map, this.deltaSourceId, false);
        addGeoJsonPinLayers(this.map, this.deltaSourceId, false);
      }
      return;
    }
    if (!this.map.getSource(this.deltaSourceId)) {
      addDeltaGeoJsonSource(this.map, this.deltaSourceId, true);
      addGeoJsonPinLayers(this.map, this.deltaSourceId, true);
    }
  }

  private applyVisibilityState(): void {
    const usePmtiles = this.pmtilesActive();
    const zoomedIn = this.zoomedIn();

    if (usePmtiles) {
      setLayerVisibility(this.map, [`${this.pinsSourceId}-heatmap`], !this.filterMode && !zoomedIn);
      setLayerVisibility(this.map, bboxPinLayerIds(this.deltaSourceId), !this.filterMode && zoomedIn);
    } else {
      const useGrid = shouldUseGrid(this.map) && (this.gridAvailable || this.gridLoader.isReady());
      setLayerVisibility(this.map, vectorPinLayerIds(this.pinsSourceId), false);
      setLayerVisibility(this.map, deltaLayerIds(this.deltaSourceId), !this.filterMode && (zoomedIn || this.deltaFeatures.length > 0));
      setLayerVisibility(this.map, gridPinLayerIds(this.gridSourceId), !this.filterMode && useGrid);
    }

    setLayerVisibility(this.map, filteredLayerIds(this.filteredSourceId), this.filterMode);

    if (this.activeTypeFilter && !this.filterMode) {
      this.filterTypes(this.activeTypeFilter);
    } else if (this.activeTypeFilter && this.filterMode) {
      setTypeFilter(this.map, this.activeTypeFilter, filteredLayerIds(this.filteredSourceId));
    }
  }

  private async attachSources(): Promise<void> {
    await registerPinIcons(this.map);
    const url = pinsPmtilesUrl(this.config);

    if (this.pmtilesActive() && url) {
      this.tearDownGridLayers();
      if (!this.map.getSource(this.pinsSourceId)) {
        addPinsVectorSource(this.map, this.pinsSourceId, url);
        addPinLayers(this.map, this.pinsSourceId, { heatmapOnly: true });
      }
    } else {
      if (url) {
        addPinsVectorSource(this.map, this.pinsSourceId, url);
        addPinLayers(this.map, this.pinsSourceId);
      }
      this.ensureGridLayer();
    }

    this.ensureFilteredLayer();
    this.flushFilteredPins();
    setSelectedPinFeature(this.map, this.selectedPin);
    this.applyVisibilityState();

    this.layerAttach = () => {
      void this.attachSources();
    };
  }

  whenReady(): Promise<void> {
    return this.layersReady;
  }

  private ensureFilteredLayer(): void {
    if (!this.map.getSource(this.filteredSourceId)) {
      this.map.addSource(this.filteredSourceId, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
        ...PIN_CLUSTER_SOURCE_OPTS,
      });
      addGeoJsonPinLayers(this.map, this.filteredSourceId);
    }
  }

  private ensureGridLayer(): void {
    if (!this.map.getSource(this.gridSourceId)) {
      this.map.addSource(this.gridSourceId, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      addGridPinLayers(this.map, this.gridSourceId);
    }
  }

  private flushDeltaPins(): void {
    const src = this.map.getSource(this.deltaSourceId) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const n = this.deltaFeatures.length;
    if (n === this.deltaFeatureCount) return;
    this.deltaFeatureCount = n;
    src.setData({ type: "FeatureCollection", features: this.deltaFeatures });
  }

  /** Heatmap when zoomed out; existing bbox fetch when zoomed in. */
  private async syncPins(): Promise<number> {
    if (this.filterMode) return 0;

    if (this.pmtilesActive() && shouldUseGrid(this.map)) {
      this.setDeltaPins([]);
      this.applyVisibilityState();
      return 0;
    }

    if (!this.pmtilesActive() && shouldUseGrid(this.map)) {
      const n = await this.gridLoader.sync();
      this.gridAvailable = this.gridAvailable || this.gridLoader.isReady();
      if (this.gridLoader.isReady()) {
        this.setDeltaPins([]);
        this.applyVisibilityState();
        return n;
      }
    }

    await this.ensureViewportPinLayers();
    this.applyVisibilityState();

    const refresh = () => this.setDeltaPins(this.pinCache.pinsInBbox(expandedBbox(this.map)));
    const { visible } = await syncViewportPins(this.config.apiBase, this.map, this.pinCache, refresh);
    refresh();
    this.applyVisibilityState();
    return visible;
  }

  async loadViewportPins(): Promise<number> {
    return this.syncPins();
  }

  async loadExistingPins(): Promise<number> {
    return this.loadViewportPins();
  }

  setDeltaPins(pins: PinFeature[]): void {
    this.deltaFeatures = pins.map((p) => this.pinFeature(p));
    this.flushDeltaPins();
  }

  async resolveInitialView(opts?: InitialViewOptions): Promise<InitialView> {
    return resolveInitialView(this.map, this.config.apiBase, opts);
  }

  isPinInView(pin: { lat: number; lng: number }): boolean {
    const b = this.map.getBounds();
    return pinInBbox(pin, {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    });
  }

  selectPin(pin: { id: string; lat: number; lng: number; t: number } | null): void {
    this.selectedPin = pin;
    setSelectedPinFeature(this.map, pin);
  }

  getSelectedPinId(): string | null {
    return this.selectedPin?.id ?? null;
  }

  onMoveEndLoadPins(): void {
    const reload = () => {
      if (this.filterMode) return;
      void this.syncPins();
    };

    this.map.on("moveend", reload);
    this.map.on("zoomend", reload);

    this.map.on("move", () => {
      if (this.pmtilesActive() || this.filterMode || !shouldUseGrid(this.map) || !this.gridAvailable) return;
      this.gridLoader.repaint();
    });
  }

  addLivePinIfVisible(pin: { id: string; lat: number; lng: number; t: number; name?: string | null }): boolean {
    if (this.filterMode || !shouldFetchPins(this.map)) return false;
    if (!this.isPinInView(pin)) return false;
    this.pinCache.addPin(pin as PinFeature);
    this.addLivePin(pin);
    return true;
  }

  cachedPinCount(): number {
    return this.pinCache.size;
  }

  async initTilesFromManifest(): Promise<boolean> {
    let ok = false;
    try {
      const manifest = await fetchTileManifest(this.config.apiBase);
      this.gridAvailable = (manifest.grid_cells ?? 0) > 0;
      if (manifest.url) {
        this.config.tilesUrl = manifest.url.startsWith("pmtiles://")
          ? manifest.url
          : `pmtiles://${manifest.url}`;
        this.useBakedTiles = true;
        ok = true;
      }
    } catch {
      /* no baked tiles yet */
    }

    this.attachDeferred = false;
    if (this.styleReady) {
      if (this.attachStarted) await this.attachSources();
      else await this.finishAttach();
    }
    return ok || this.pmtilesActive();
  }

  async reloadBakedTiles(): Promise<boolean> {
    try {
      this.gridLoader.clear();
      const manifest = await fetchTileManifest(this.config.apiBase);
      this.gridAvailable = (manifest.grid_cells ?? 0) > 0;

      if (manifest.url) {
        const url = manifest.url.startsWith("pmtiles://") ? manifest.url : `pmtiles://${manifest.url}`;
        this.config.tilesUrl = url;
        this.useBakedTiles = true;
        for (const id of vectorPinLayerIds(this.pinsSourceId)) {
          if (this.map.getLayer(id)) this.map.removeLayer(id);
        }
        if (this.map.getSource(this.pinsSourceId)) this.map.removeSource(this.pinsSourceId);
        removeGeoJsonPinLayers(this.map, this.deltaSourceId);
        if (this.map.getSource(this.deltaSourceId)) this.map.removeSource(this.deltaSourceId);
        this.deltaFeatures = [];
        this.deltaFeatureCount = -1;
        if (this.styleReady) await this.attachSources();
      } else {
        this.config.tilesUrl = null;
        this.useBakedTiles = false;
      }

      await this.syncPins();
      return this.useBakedTiles || this.pinCache.size > 0;
    } catch {
      return false;
    }
  }

  hasBakedTiles(): boolean {
    return this.useBakedTiles;
  }

  hasGridFallback(): boolean {
    return this.gridAvailable;
  }

  async tryOfflineFirst(): Promise<boolean> {
    if (!(await hasOfflineTiles())) return false;
    const blobUrl = await getOfflineTilesUrl();
    if (!blobUrl) return false;
    this.config.offlineTilesPath = blobUrl;
    this.config.tilesUrl = null;
    this.useBakedTiles = true;
    return true;
  }

  watchSystemTheme(): () => void {
    return watchTheme(
      this.map,
      (d) => {
        this.dark = d;
        setMapTheme(this.map, d, () => void this.reattachAfterStyleChange());
      },
      () => void this.reattachAfterStyleChange(),
      { skipInitial: true },
    );
  }

  private async reattachAfterStyleChange(): Promise<void> {
    await this.attachSources();
    await this.syncPins();
  }

  onMoveEndEnrich(since?: string): void {
    this.map.on("moveend", () => {
      scheduleViewportEnrich(this.map, this.config.apiBase, this.pinsSourceId, since);
    });
  }

  addLivePin(pin: { id: string; lat: number; lng: number; t: number; name?: string | null }): void {
    if (this.pmtilesActive() && shouldUseGrid(this.map)) return;
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
    this.applyVisibilityState();
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
      : this.pmtilesActive()
        ? bboxPinLayerIds(this.deltaSourceId)
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
    void this.syncPins();
  }

  onPinClick(handler: (pin: { id: string; lat: number; lng: number; t: number }) => void): void {
    registerPinInteractions(this.map, handler);
  }
}

export * from "./colors";
export { typeIconSvg, attrIcon, ATTR_ICONS } from "./icons/pin-icons";
export * from "./types";
export { streamSearch, fetchPlaceDetail, downloadPinsPmtiles, hasOfflineTiles };
