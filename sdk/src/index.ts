import type maplibregl from "maplibre-gl";
import type { P5nConfig, PinFeature } from "./types";
import { fetchPlaceDetail } from "./detail/place-detail";
import { scheduleViewportEnrich } from "./enrich/viewport-enrich";
import { resolveInitialView, type InitialView, type InitialViewOptions } from "./geo/initial-view";
import {
  addGeoJsonPinLayers,
  addBboxPinLayers,
  addGridPinLayers,
  addPinLayers,
  baseLayerIds,
  bboxPinLayerIds,
  deltaLayerIds,
  filteredLayerIds,
  gridPinLayerIds,
  PIN_CLUSTER_SOURCE_OPTS,
  removeGeoJsonPinLayers,
  setLayerVisibility,
  setSelectedPinFeature,
  setTypeFilter,
  vectorPinLayerIds,
} from "./layers/pins";
import { registerPinInteractions } from "./pin-interactions";
import {
  expandedBbox,
  MAX_PINS_IN_VIEW,
  pinInBbox,
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
      if (this.manifestReady) void this.finishAttach();
    });
  }

  private finishAttach(): Promise<void> {
    return this.attachSources().then(async () => {
      this.resolveLayersReady();
      if (!shouldUseGrid(this.map) && !this.filterMode) {
        await this.loadViewportPins();
      }
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
  private manifestReady = false;
  private deltaClustered: boolean | null = null;

  private pmtilesActive(): boolean {
    return this.useBakedTiles && pinsPmtilesUrl(this.config) != null;
  }

  private async attachSources(): Promise<void> {
    await registerPinIcons(this.map);
    // Offline-only: baked PMTiles. Online heatmap uses pin_grid GeoJSON (reliable).
    const url = pinsPmtilesUrl(this.config);
    if (url && this.config.offlineTilesPath) {
      if (!this.map.getSource(this.pinsSourceId)) {
        addPinsVectorSource(this.map, this.pinsSourceId, url);
      }
      addPinLayers(this.map, this.pinsSourceId, { heatmapOnly: true });
    }
    this.ensureDeltaOverlay();
    this.ensureGridLayer();
    setSelectedPinFeature(this.map, this.selectedPin);
    this.applyVisibilityState();
    this.layerAttach = () => {
      void this.attachSources();
    };
  }

  /** PMTiles heatmap when zoomed out; compact bbox pins when zoomed in. */
  private ensureDeltaOverlay(): void {
    if (!this.map.isStyleLoaded()) {
      this.map.once("load", () => this.ensureDeltaOverlay());
      return;
    }

    const wantCluster = !this.pmtilesActive();
    if (this.map.getSource(this.deltaSourceId) && this.deltaClustered !== wantCluster) {
      removeGeoJsonPinLayers(this.map, this.deltaSourceId);
      this.map.removeSource(this.deltaSourceId);
      this.deltaFeatureCount = -1;
    }

    addDeltaGeoJsonSource(this.map, this.deltaSourceId, wantCluster);
    if (wantCluster) {
      addGeoJsonPinLayers(this.map, this.deltaSourceId, true);
    } else {
      addBboxPinLayers(this.map, this.deltaSourceId);
    }
    this.deltaClustered = wantCluster;
    this.ensureFilteredLayer();
    this.raiseBboxLayers();
  }

  /** Wait until pin sources/layers are on the map. */
  whenReady(): Promise<void> {
    return this.layersReady;
  }

  /** Keep viewport pin markers above grid/PMTiles heatmap. */
  private raiseBboxLayers(): void {
    for (const id of bboxPinLayerIds(this.deltaSourceId)) {
      if (this.map.getLayer(id)) {
        try {
          this.map.moveLayer(id);
        } catch {
          /* already on top */
        }
      }
    }
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
    const zoomedIn = !shouldUseGrid(this.map);
    const offlinePmtiles = this.pmtilesActive() && !!this.config.offlineTilesPath;
    const showGrid =
      shouldUseGrid(this.map) && (this.gridAvailable || this.gridLoader.isReady()) && !offlinePmtiles;
    const showDelta =
      !this.filterMode &&
      (offlinePmtiles ? zoomedIn : this.deltaFeatures.length > 0 || !showGrid);

    if (offlinePmtiles) {
      setLayerVisibility(this.map, [`${this.pinsSourceId}-heatmap`], !this.filterMode && !zoomedIn);
      setLayerVisibility(this.map, vectorPinLayerIds(this.pinsSourceId).slice(1), false);
      setLayerVisibility(this.map, bboxPinLayerIds(this.deltaSourceId), !this.filterMode);
    } else if (this.pmtilesActive()) {
      setLayerVisibility(this.map, vectorPinLayerIds(this.pinsSourceId), false);
      setLayerVisibility(this.map, bboxPinLayerIds(this.deltaSourceId), !this.filterMode && zoomedIn);
    } else {
      setLayerVisibility(this.map, vectorPinLayerIds(this.pinsSourceId), !this.filterMode);
      setLayerVisibility(this.map, deltaLayerIds(this.deltaSourceId), showDelta);
    }
    setLayerVisibility(this.map, gridPinLayerIds(this.gridSourceId), !this.filterMode && showGrid);
    setLayerVisibility(this.map, filteredLayerIds(this.filteredSourceId), this.filterMode);

    if (this.activeTypeFilter && !this.filterMode) {
      this.filterTypes(this.activeTypeFilter);
    } else if (this.activeTypeFilter && this.filterMode) {
      setTypeFilter(this.map, this.activeTypeFilter, filteredLayerIds(this.filteredSourceId));
    }
  }

  private flushDeltaPins(): void {
    if (!this.map.getSource(this.deltaSourceId)) {
      this.ensureDeltaOverlay();
    }
    const src = this.map.getSource(this.deltaSourceId) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const n = this.deltaFeatures.length;
    if (n === this.deltaFeatureCount) return;
    this.deltaFeatureCount = n;
    src.setData({ type: "FeatureCollection", features: this.deltaFeatures });
    this.applyVisibilityState();
  }

  async loadViewportPins(): Promise<number> {
    if (!this.map.getLayer(`${this.deltaSourceId}-circles`)) {
      this.ensureDeltaOverlay();
    }

    if (shouldUseGrid(this.map)) {
      this.ensureGridLayer();
      this.applyVisibilityState();
      const n = await this.gridLoader.sync();
      this.gridAvailable = this.gridAvailable || this.gridLoader.isReady();
      if (this.pmtilesActive() || this.gridLoader.isReady()) {
        this.setDeltaPins([]);
        this.applyVisibilityState();
        return n;
      }
    }

    this.applyVisibilityState();
    const refresh = () => this.setDeltaPins(this.pinCache.pinsInBbox(expandedBbox(this.map)));
    const { visible } = await syncViewportPins(this.config.apiBase, this.map, this.pinCache, refresh);
    refresh();
    this.applyVisibilityState();
    this.raiseBboxLayers();
    this.scheduleEnrichForViewport();
    return visible;
  }

  private scheduleEnrichForViewport(): void {
    if (this.filterMode || shouldUseGrid(this.map)) return;
    const ids = this.deltaFeatures
      .slice(0, 500)
      .map((f) => String(f.properties?.id ?? f.id ?? ""))
      .filter(Boolean);
    scheduleViewportEnrich(this.map, this.config.apiBase, this.deltaSourceId, ids);
  }

  setDeltaPins(pins: PinFeature[]): void {
    this.deltaFeatures = pins.slice(0, MAX_PINS_IN_VIEW).map((p) => this.pinFeature(p));
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
      if (this.filterMode || !shouldUseGrid(this.map) || !this.gridAvailable) return;
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
    this.manifestReady = true;
    if (this.styleReady) await this.finishAttach();
    return ok;
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
