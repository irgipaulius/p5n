import type maplibregl from "maplibre-gl";
import type { P5nConfig, PinFeature } from "./types";
import { fetchPlaceDetail } from "./detail/place-detail";
import { scheduleViewportEnrich } from "./enrich/viewport-enrich";
import { resolveInitialView, type InitialView, type InitialViewOptions } from "./geo/initial-view";
import {
  addDeltaPinLayers,
  addGeoJsonPinLayers,
  addGridPinLayers,
  addPinLayers,
  baseLayerIds,
  deltaLayerIds,
  filteredLayerIds,
  gridPinLayerIds,
  PIN_CLUSTER_SOURCE_OPTS,
  setLayerVisibility,
  setSelectedPinFeature,
  setTypeFilter,
  vectorPinLayerIds,
} from "./layers/pins";
import { registerPinInteractions } from "./pin-interactions";
import {
  expandedBbox,
  pinInBbox,
  scheduleViewportPins,
  syncViewportPins,
  shouldFetchPins,
  shouldUseGrid,
} from "./pins/viewport-pins";
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
      void this.attachSources().then(() => this.resolveLayersReady());
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

  private pmtilesActive(): boolean {
    return this.useBakedTiles && pinsPmtilesUrl(this.config) != null;
  }

  private async attachSources(): Promise<void> {
    await registerPinIcons(this.map);
    const url = pinsPmtilesUrl(this.config);
    if (url) {
      if (!this.map.getSource(this.pinsSourceId)) {
        addPinsVectorSource(this.map, this.pinsSourceId, url);
      }
      addPinLayers(this.map, this.pinsSourceId, { heatmapOnly: true });
    }
    await this.ensureDeltaLayer();
    if (!this.pmtilesActive()) {
      this.ensureGridLayer();
    }
    setSelectedPinFeature(this.map, this.selectedPin);
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

  private applyVisibilityState(): void {
    const usePmtiles = this.pmtilesActive();
    const zoomedIn = !shouldUseGrid(this.map);
    const useGrid =
      !usePmtiles && shouldUseGrid(this.map) && (this.gridAvailable || this.gridLoader.isReady());
    const showDelta =
      !this.filterMode &&
      (usePmtiles ? zoomedIn : this.deltaFeatures.length > 0 || !useGrid);

    if (usePmtiles) {
      setLayerVisibility(this.map, [`${this.pinsSourceId}-heatmap`], !this.filterMode && !zoomedIn);
      setLayerVisibility(this.map, vectorPinLayerIds(this.pinsSourceId).slice(1), false);
    } else {
      setLayerVisibility(this.map, vectorPinLayerIds(this.pinsSourceId), !this.filterMode);
    }

    setLayerVisibility(this.map, deltaLayerIds(this.deltaSourceId), showDelta);
    setLayerVisibility(this.map, gridPinLayerIds(this.gridSourceId), !this.filterMode && useGrid);
    setLayerVisibility(this.map, filteredLayerIds(this.filteredSourceId), this.filterMode);

    if (this.activeTypeFilter && !this.filterMode) {
      this.filterTypes(this.activeTypeFilter);
    } else if (this.activeTypeFilter && this.filterMode) {
      setTypeFilter(this.map, this.activeTypeFilter, filteredLayerIds(this.filteredSourceId));
    } else if (this.activeTypeFilter) {
      setTypeFilter(this.map, this.activeTypeFilter, [
        ...deltaLayerIds(this.deltaSourceId),
        ...filteredLayerIds(this.filteredSourceId),
      ]);
    }
  }

  private flushDeltaPins(): void {
    const src = this.map.getSource(this.deltaSourceId) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const n = this.deltaFeatures.length;
    if (n === this.deltaFeatureCount) return;
    this.deltaFeatureCount = n;
    src.setData({ type: "FeatureCollection", features: this.deltaFeatures });
    this.applyVisibilityState();
  }

  async loadViewportPins(): Promise<number> {
    if (this.pmtilesActive() && shouldUseGrid(this.map)) {
      this.setDeltaPins([]);
      this.applyVisibilityState();
      return 0;
    }

    if (!this.pmtilesActive() && shouldUseGrid(this.map)) {
      this.applyVisibilityState();
      const n = await this.gridLoader.sync();
      this.gridAvailable = this.gridAvailable || this.gridLoader.isReady();
      if (this.gridLoader.isReady()) {
        this.setDeltaPins([]);
        this.applyVisibilityState();
        return n;
      }
    }

    this.applyVisibilityState();
    const refresh = () => this.setDeltaPins(this.pinCache.pinsInBbox(expandedBbox(this.map)));
    const { visible } = await syncViewportPins(this.config.apiBase, this.map, this.pinCache, refresh);
    refresh();
    return visible;
  }

  /** @deprecated Use loadViewportPins — loads only pins in the current map view. */
  async loadExistingPins(): Promise<number> {
    return this.loadViewportPins();
  }

  setDeltaPins(pins: PinFeature[]): void {
    this.deltaFeatures = pins.map((p) => this.pinFeature(p));
    this.flushDeltaPins();
  }

  /** IP geolocation first, then browser location prompt; centers the map. */
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
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    this.map.on("move", () => {
      if (this.pmtilesActive() || this.filterMode || !shouldUseGrid(this.map) || !this.gridAvailable) return;
      if (moveTimer) return;
      moveTimer = setTimeout(() => {
        moveTimer = null;
        this.gridLoader.repaint();
      }, 50);
    });

    const reload = () => {
      if (this.filterMode) return;
      void this.loadViewportPins();
    };

    this.map.on("moveend", reload);
    this.map.on("zoomend", reload);
  }

  addLivePinIfVisible(pin: { id: string; lat: number; lng: number; t: number; name?: string | null }): boolean {
    if (this.filterMode || !shouldFetchPins(this.map)) return false;
    if (!this.isPinInView(pin)) return false;
    this.pinCache.addPin(pin as PinFeature);
    this.addLivePin(pin);
    return true;
  }

  /** Pins held in this browser session (survives pan/zoom without refetch). */
  cachedPinCount(): number {
    return this.pinCache.size;
  }

  async initTilesFromManifest(): Promise<boolean> {
    try {
      const manifest = await fetchTileManifest(this.config.apiBase);
      this.gridAvailable = (manifest.grid_cells ?? 0) > 0;
      if (manifest.url) {
        this.config.tilesUrl = manifest.url.startsWith("pmtiles://")
          ? manifest.url
          : `pmtiles://${manifest.url}`;
        this.useBakedTiles = true;
        if (this.styleReady) await this.attachSources();
        return true;
      }
    } catch {
      /* no baked tiles yet */
    }
    return false;
  }

  /** Reload grid/baked state after dashboard bake. */
  async reloadBakedTiles(): Promise<boolean> {
    try {
      this.gridLoader.clear();

      const manifest = await fetchTileManifest(this.config.apiBase);
      this.gridAvailable = (manifest.grid_cells ?? 0) > 0;

      if (manifest.url) {
        const url = manifest.url.startsWith("pmtiles://") ? manifest.url : `pmtiles://${manifest.url}`;
        if (this.config.tilesUrl !== url || !this.map.getSource(this.pinsSourceId)) {
          this.config.tilesUrl = url;
          this.useBakedTiles = true;
          for (const id of vectorPinLayerIds(this.pinsSourceId)) {
            if (this.map.getLayer(id)) this.map.removeLayer(id);
          }
          if (this.map.getSource(this.pinsSourceId)) this.map.removeSource(this.pinsSourceId);
          if (this.styleReady) await this.attachSources();
        }
      } else {
        this.config.tilesUrl = null;
        this.useBakedTiles = false;
      }

      await this.loadViewportPins();
      return this.useBakedTiles || this.pinCache.size > 0;
    } catch {
      return false;
    }
  }

  hasBakedTiles(): boolean {
    return this.useBakedTiles;
  }

  /** Geohash4 grid fallback when PMTiles manifest is absent. */
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
        ? deltaLayerIds(this.deltaSourceId)
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
    void this.loadViewportPins();
  }

  onPinClick(handler: (pin: { id: string; lat: number; lng: number; t: number }) => void): void {
    registerPinInteractions(this.map, handler);
  }
}

export * from "./colors";
export { typeIconSvg, attrIcon, ATTR_ICONS } from "./icons/pin-icons";
export * from "./types";
export { streamSearch, fetchPlaceDetail, downloadPinsPmtiles, hasOfflineTiles };
