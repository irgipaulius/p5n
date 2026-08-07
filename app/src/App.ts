import { P5nMap, TYPE_LABELS, attrIcon, typeIconSvg, typeToInt, type PinFeature } from "@p5n/sdk";
import maplibregl from "maplibre-gl";
import { installDrawerSwipe } from "./drawer-swipe";
import { installDetailSwipe } from "./detail-swipe";
import { installPullRefreshGuard } from "./pull-guard";
import { canShowInstallButton, promptInstall, watchInstallPrompt } from "./install-app";
import { initPlaceDetailPanel, loadPlaceDetail, parsePlaceIdFromPath, renderPlaceDetail, renderPlaceDetailSkeleton } from "./place-detail";

const API_BASE = import.meta.env.DEV ? "" : "";

interface AttributeDef {
  bit_index: number;
  column_name: "attrs0" | "attrs1";
  key: string;
  label: string;
}

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="layout">
      <div id="map"></div>

      <header class="top-bar">
        <label class="search-field glass" for="search">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C8.01 14 6 11.99 6 9.5S8.01 5 10.5 5 15 7.01 15 9.5 12.99 14 10.5 14z"/></svg>
          <input type="text" inputmode="search" enterkeyhint="search" id="search" placeholder="Search in this area…" autocomplete="off" autocapitalize="off" spellcheck="false" />
        </label>
        <button type="button" id="btn-search" class="btn btn-accent desktop-only">Search</button>
        <button type="button" class="float-filters-btn glass" id="btn-filters" aria-expanded="false">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>
          <span class="filters-label">Filters</span>
        </button>
      </header>
      <p class="search-meta" id="search-meta" aria-live="polite"></p>


      <button type="button" class="float float-admin-toggle glass mobile-only" id="btn-admin-toggle" aria-expanded="false" aria-label="Scraper &amp; log">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
      </button>

      <button type="button" class="float float-install glass mobile-only" id="btn-install" hidden aria-label="Add to home screen">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        <span>Install</span>
      </button>

      <div class="admin-wrap" id="admin-wrap">
        <div class="float float-scrape glass">
          <button type="button" id="btn-start" class="btn btn-accent">Start scrape</button>
          <button type="button" id="btn-toggle" class="btn">Pause</button>
          <button type="button" id="btn-bake" class="btn" title="Build PMTiles heatmap pyramid and publish to tile storage">Bake tiles</button>
          <div class="stats" id="stats">…</div>
          <span class="status" id="status"></span>
          <span class="bake-status" id="bake-status"></span>
        </div>
        <div class="float float-log glass" id="log"></div>
      </div>

      <aside class="float float-drawer glass" id="drawer" aria-hidden="true">
        <div class="drawer-handle" aria-hidden="true"></div>
        <header class="drawer-head">
          <h2>Filters</h2>
          <button type="button" class="btn-icon" id="btn-close-drawer" aria-label="Close">✕</button>
        </header>
        <div class="drawer-scroll">
        <section class="drawer-section">
          <h3>Quality</h3>
          <div class="filter-row">
            <div class="field">
              <span>Minimum rating</span>
              <div class="star-min" id="min-rating-stars" role="group" aria-label="Minimum rating">
                <button type="button" class="star-btn" data-min="1" aria-label="At least 1 star">★</button>
                <button type="button" class="star-btn" data-min="2" aria-label="At least 2 stars">★</button>
                <button type="button" class="star-btn" data-min="3" aria-label="At least 3 stars">★</button>
                <button type="button" class="star-btn" data-min="4" aria-label="At least 4 stars">★</button>
              </div>
              <span class="star-hint" id="star-hint">Any rating</span>
            </div>
            <label class="chip" id="chip-photos">
              <input type="checkbox" id="has-photos" />
              <span>📷 Has photos</span>
            </label>
          </div>
        </section>
        <section class="drawer-section">
          <h3>Place type</h3>
          <div class="chip-grid" id="type-filters"></div>
        </section>
        <section class="drawer-section">
          <h3>Facilities & features</h3>
          <div class="chip-grid" id="attr-filters"></div>
        </section>
        </div>
        <footer class="drawer-foot">
          <button type="button" class="btn" id="btn-clear-filters">Clear all</button>
        </footer>
      </aside>

      <aside class="float float-detail glass" id="detail"></aside>
    </div>
  `;

  const mapEl = root.querySelector("#map") as HTMLElement;
  const statsEl = root.querySelector("#stats") as HTMLElement;
  const logEl = root.querySelector("#log") as HTMLElement;
  const detailEl = root.querySelector("#detail") as HTMLElement;
  const statusEl = root.querySelector("#status") as HTMLElement;
  const searchInput = root.querySelector("#search") as HTMLInputElement;
  const searchMeta = root.querySelector("#search-meta") as HTMLElement;
  const btnStart = root.querySelector("#btn-start") as HTMLButtonElement;
  const btnToggle = root.querySelector("#btn-toggle") as HTMLButtonElement;
  const btnBake = root.querySelector("#btn-bake") as HTMLButtonElement;
  const bakeStatusEl = root.querySelector("#bake-status") as HTMLElement;
  const drawer = root.querySelector("#drawer") as HTMLElement;
  const btnFilters = root.querySelector("#btn-filters") as HTMLButtonElement;
  const typeFiltersEl = root.querySelector("#type-filters") as HTMLElement;
  const attrFiltersEl = root.querySelector("#attr-filters") as HTMLElement;
  const minRatingStars = root.querySelector("#min-rating-stars") as HTMLElement;
  const starHint = root.querySelector("#star-hint") as HTMLElement;
  const hasPhotosEl = root.querySelector("#has-photos") as HTMLInputElement;
  const chipPhotos = root.querySelector("#chip-photos") as HTMLElement;
  const adminWrap = root.querySelector("#admin-wrap") as HTMLElement;
  const btnAdminToggle = root.querySelector("#btn-admin-toggle") as HTMLButtonElement;
  const btnInstall = root.querySelector("#btn-install") as HTMLButtonElement;

  let minRating = 0;
  let searchAbort: AbortController | null = null;
  let searchInputTimer: number | undefined;
  let viewportSearchTimer: number | undefined;
  let searchGeneration = 0;

  const p5n = new P5nMap(mapEl, { apiBase: API_BASE, dark: true });
  installPullRefreshGuard(mapEl);
  p5n.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  p5n.map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "bottom-right");
  p5n.map.addControl(new maplibregl.ScaleControl(), "bottom-left");

  let scraping = false;
  let baking = false;
  let bakePollTimer: number | undefined;
  let attributes: AttributeDef[] = [];
  const selectedTypes = new Set(Object.keys(TYPE_LABELS).map(Number));
  const selectedAttrs = new Set<string>();
  const deepPlaceId = parsePlaceIdFromPath();

  void (async () => {
    await p5n.tryOfflineFirst();
    await p5n.initTilesFromManifest();
    await p5n.whenReady();
    p5n.watchSystemTheme();

    let deepCenter: { lat: number; lng: number; zoom: number } | undefined;
    if (deepPlaceId) {
      try {
        const data = await loadPlaceDetail(API_BASE, deepPlaceId, false);
        if (data.lat != null && data.lng != null) {
          deepCenter = { lat: data.lat, lng: data.lng, zoom: 14 };
        }
      } catch {
        /* openPlaceById will show the error */
      }
    }

    const view = await p5n.resolveInitialView(
      deepCenter
        ? { center: deepCenter }
        : deepPlaceId
          ? { skipGeolocation: true }
          : undefined,
    );
    p5n.onMoveEndLoadPins();
    p5n.map.on("moveend", () => {
      scheduleViewportSearch(450);
    });
    p5n.filterTypes([...selectedTypes]);
    const n = await p5n.loadViewportPins();
    statusEl.textContent = p5n.hasBakedTiles()
      ? "PMTiles loaded"
      : p5n.hasGridFallback()
        ? "grid fallback"
        : n
          ? `${n} pins nearby`
          : view.source === "place"
            ? "shared place"
            : view.source === "gps"
              ? "ready"
              : "ready — pan to explore";
    await refreshStats();
    if (baking) startBakePoll();
    await loadAttributes();
    buildTypeFilters();
    buildAttrFilters();

    if (deepPlaceId) {
      await openPlaceById(deepPlaceId, { updateUrl: false, flyTo: !deepCenter });
    }
  })();

  async function openPlaceById(
    placeId: string,
    opts: { pin?: { id: string; lat: number; lng: number; t: number }; updateUrl?: boolean; flyTo?: boolean } = {},
  ): Promise<void> {
    const updateUrl = opts.updateUrl !== false;
    if (updateUrl && parsePlaceIdFromPath() !== placeId) {
      history.pushState({ placeId }, "", `/${placeId}`);
    }

    if (opts.pin) p5n.selectPin(opts.pin);
    detailEl.classList.add("open");
    detailEl.innerHTML = renderPlaceDetailSkeleton();
    detailEl.querySelector("#btn-close-detail")?.addEventListener("click", closeDetail);

    try {
      const data = await loadPlaceDetail(API_BASE, placeId, true);
      const typeInt = typeToInt(String(data.type || "P"));
      if (data.lat != null && data.lng != null) {
        p5n.selectPin({ id: placeId, lat: data.lat, lng: data.lng, t: typeInt });
        if (opts.flyTo !== false) {
          p5n.map.flyTo({ center: [data.lng, data.lat], zoom: 14, duration: 700 });
        }
      }
      detailEl.innerHTML = renderPlaceDetail(data, attributes, typeInt);
      initPlaceDetailPanel(detailEl, data);
      detailEl.querySelector("#btn-close-detail")?.addEventListener("click", closeDetail);
    } catch (err) {
      detailEl.innerHTML = `<header class="detail-head"><h2>Error</h2><button class="btn-icon" id="btn-close-detail">✕</button></header><p class="muted">${escapeHtml(String(err))}</p>`;
      detailEl.querySelector("#btn-close-detail")?.addEventListener("click", closeDetail);
    }
  }

  p5n.onPinClick(async (pin) => {
    await openPlaceById(pin.id, { pin });
  });

  function closeDetail(): void {
    detailEl.classList.remove("open");
    detailEl.style.transform = "";
    p5n.selectPin(null);
    if (parsePlaceIdFromPath()) {
      history.pushState(null, "", "/");
    }
  }

  installDetailSwipe(detailEl, closeDetail);

  window.addEventListener("popstate", () => {
    const id = parsePlaceIdFromPath();
    if (id) {
      void openPlaceById(id, { updateUrl: false });
      return;
    }
    detailEl.classList.remove("open");
    p5n.selectPin(null);
  });

  async function loadAttributes(): Promise<void> {
    const resp = await fetch(`${API_BASE}/api/attributes`);
    if (!resp.ok) return;
    const data = await resp.json();
    attributes = (data as { attributes: AttributeDef[] }).attributes ?? [];
  }

  function buildTypeFilters(): void {
    typeFiltersEl.innerHTML = "";
    for (const [t, label] of Object.entries(TYPE_LABELS)) {
      const n = Number(t);
      const chip = document.createElement("label");
      chip.className = "chip active";
      chip.innerHTML = `<input type="checkbox" checked data-t="${n}" /><span class="type-icon">${typeIconSvg(n, 18)}</span>${label}`;
      chip.querySelector("input")!.addEventListener("change", (e) => {
        const on = (e.target as HTMLInputElement).checked;
        chip.classList.toggle("active", on);
        if (on) selectedTypes.add(n);
        else selectedTypes.delete(n);
        applyFilters();
      });
      typeFiltersEl.appendChild(chip);
    }
  }

  function buildAttrFilters(): void {
    attrFiltersEl.innerHTML = "";
    for (const attr of attributes) {
      const chip = document.createElement("label");
      chip.className = "chip";
      chip.innerHTML = `<input type="checkbox" data-key="${attr.key}" data-col="${attr.column_name}" data-bit="${attr.bit_index}" /><span class="attr-icon">${attrIcon(attr.key)}</span><span>${attr.label}</span>`;
      chip.querySelector("input")!.addEventListener("change", (e) => {
        const on = (e.target as HTMLInputElement).checked;
        chip.classList.toggle("active", on);
        if (on) selectedAttrs.add(attr.key);
        else selectedAttrs.delete(attr.key);
        applyFilters();
      });
      attrFiltersEl.appendChild(chip);
    }
  }

  function attrMasks(): { attrs0?: number; attrs1?: number } {
    let attrs0 = 0;
    let attrs1 = 0;
    for (const key of selectedAttrs) {
      const def = attributes.find((a) => a.key === key);
      if (!def) continue;
      if (def.column_name === "attrs0") attrs0 |= 1 << def.bit_index;
      else attrs1 |= 1 << def.bit_index;
    }
    return { attrs0: attrs0 || undefined, attrs1: attrs1 || undefined };
  }

  function filterByTypes(pins: PinFeature[]): PinFeature[] {
    if (selectedTypes.size === 0) return [];
    return pins.filter((p) => selectedTypes.has(Number(p.t)));
  }

  function mapBbox(): { west: number; south: number; east: number; north: number } {
    const b = p5n.map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  }

  function hasAdvancedFilters(): boolean {
    return Boolean(searchInput.value.trim()) || selectedAttrs.size > 0 || minRating > 0 || hasPhotosEl.checked;
  }

  function scheduleSearchInput(): void {
    window.clearTimeout(searchInputTimer);
    searchInputTimer = window.setTimeout(() => {
      if (!hasAdvancedFilters()) {
        applyFilters();
        return;
      }
      void applyAllFilters();
    }, 250);
  }

  function scheduleViewportSearch(ms: number): void {
    if (!hasAdvancedFilters()) return;
    window.clearTimeout(viewportSearchTimer);
    viewportSearchTimer = window.setTimeout(() => void applyAllFilters(), ms);
  }

  function applyFilters(): void {
    if (hasAdvancedFilters()) {
      void applyAllFilters();
      return;
    }
    p5n.clearFilteredPins();
    p5n.filterTypes(selectedTypes.size ? [...selectedTypes] : []);
    searchMeta.textContent = "";
    void p5n.loadViewportPins();
  }

  async function applyAllFilters(): Promise<void> {
    const gen = ++searchGeneration;
    searchAbort?.abort();
    searchAbort = new AbortController();
    const signal = searchAbort.signal;

    const q = searchInput.value.trim();
    const { attrs0, attrs1 } = attrMasks();
    const hasPhotos = hasPhotosEl.checked;
    const bbox = mapBbox();

    const results: PinFeature[] = [];
    searchMeta.textContent = "searching…";
    p5n.showFilteredPins([]);

    try {
      await p5n.search({
        q: q || undefined,
        attrs0,
        attrs1,
        minRating: minRating || undefined,
        hasPhotos: hasPhotos || undefined,
        limit: 500,
        west: bbox.west,
        south: bbox.south,
        east: bbox.east,
        north: bbox.north,
        signal,
        onPin: (pin) => {
          if (gen !== searchGeneration) return;
          results.push(pin);
          const typed = filterByTypes(results);
          p5n.showFilteredPins(typed);
          searchMeta.textContent = `${typed.length}…`;
        },
      });
    } catch (err) {
      if (signal.aborted) return;
      searchMeta.textContent = "search failed";
      return;
    }

    if (gen !== searchGeneration) return;
    const typed = filterByTypes(results);
    p5n.showFilteredPins(typed);
    p5n.filterTypes(selectedTypes.size ? [...selectedTypes] : []);
    searchMeta.textContent = typed.length ? `${typed.length} in view` : "none in view";
  }

  function updateStarUi(): void {
    minRatingStars.querySelectorAll<HTMLButtonElement>(".star-btn").forEach((btn) => {
      const n = Number(btn.dataset.min);
      btn.classList.toggle("active", minRating > 0 && n <= minRating);
    });
    starHint.textContent = minRating > 0 ? `${minRating}+ stars minimum` : "Any rating";
  }

  minRatingStars.querySelectorAll<HTMLButtonElement>(".star-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.min);
      minRating = minRating === n ? 0 : n;
      updateStarUi();
      applyFilters();
    });
  });

  hasPhotosEl.addEventListener("change", () => {
    chipPhotos.classList.toggle("active", hasPhotosEl.checked);
    applyFilters();
  });

  function closeDrawer(): void {
    drawer.classList.remove("open");
    btnFilters.setAttribute("aria-expanded", "false");
    drawer.setAttribute("aria-hidden", "true");
    drawer.style.transform = "";
  }

  installDrawerSwipe(drawer, closeDrawer);

  root.querySelector("#btn-search")!.addEventListener("click", () => void applyAllFilters());
  searchInput.addEventListener("input", () => scheduleSearchInput());
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      window.clearTimeout(searchInputTimer);
      void applyAllFilters();
    }
  });

  btnAdminToggle.addEventListener("click", () => {
    const open = adminWrap.classList.toggle("open");
    btnAdminToggle.setAttribute("aria-expanded", String(open));
  });

  watchInstallPrompt(() => {
    if (canShowInstallButton()) btnInstall.hidden = false;
  });
  if (canShowInstallButton()) btnInstall.hidden = false;

  btnInstall.addEventListener("click", () => {
    void (async () => {
      const outcome = await promptInstall();
      if (outcome === "ios-help") {
        window.alert("Tap Share in Safari, then “Add to Home Screen” to install this app.");
      } else if (outcome === "accepted") {
        btnInstall.hidden = true;
      }
    })();
  });

  btnFilters.addEventListener("click", () => {
    const open = drawer.classList.toggle("open");
    btnFilters.setAttribute("aria-expanded", String(open));
    drawer.setAttribute("aria-hidden", String(!open));
  });
  root.querySelector("#btn-close-drawer")!.addEventListener("click", closeDrawer);
  root.querySelector("#btn-clear-filters")!.addEventListener("click", () => {
    selectedAttrs.clear();
    attrFiltersEl.querySelectorAll<HTMLInputElement>("input").forEach((el) => {
      el.checked = false;
      el.closest(".chip")?.classList.remove("active");
    });
    selectedTypes.clear();
    Object.keys(TYPE_LABELS).forEach((t) => selectedTypes.add(Number(t)));
    typeFiltersEl.querySelectorAll<HTMLInputElement>("input").forEach((el) => {
      el.checked = true;
      el.closest(".chip")?.classList.add("active");
    });
    minRating = 0;
    updateStarUi();
    hasPhotosEl.checked = false;
    chipPhotos.classList.remove("active");
    p5n.clearFilteredPins();
    p5n.filterTypes([...selectedTypes]);
    searchMeta.textContent = "";
    searchInput.value = "";
    applyFilters();
  });

  async function post(path: string): Promise<Record<string, unknown>> {
    const resp = await fetch(`${API_BASE}${path}`, { method: "POST" });
    return resp.json();
  }

  async function refreshStats(): Promise<void> {
    const resp = await fetch(`${API_BASE}/api/stats`);
    const data = await resp.json();
    if (!resp.ok || (data as { error?: string }).error) return;
    applyStats(data);
  }

  function applyStats(stats: unknown): void {
    const s = stats as {
      places?: number;
      db_mb?: number;
      db_limit_mb?: number;
      jobs?: Record<string, number>;
      state?: { paused: number; storage_handbrake?: number; max_places: number };
      pass?: { done: number; total: number; pending: number };
      tile_manifest?: {
        version?: number;
        place_count?: number;
        bytes?: number;
        built_at?: string | null;
        bake_status?: string;
        bake_progress?: number;
        bake_total?: number;
        bake_error?: string | null;
      };
    };
    scraping = s.state?.paused === 0;
    const dbMb = s.db_mb ?? 0;
    const limitMb = s.db_limit_mb ?? 4608;
    const dbClass = dbMb >= limitMb * 0.85 ? "stats-warn" : "";
    const passLine =
      s.pass?.total && s.pass.total > 0
        ? `<span>${s.pass.done}/${s.pass.total} cells</span>`
        : "";
    const tm = s.tile_manifest;
    const gridCells = (tm as { grid_cells?: number })?.grid_cells ?? 0;
    const bakedLine =
      tm?.version && tm.version > 0
        ? `<span class="stats-baked" title="PMTiles v${tm.version}">${tm.place_count ?? 0} pins · ${tm.bytes ? `${(tm.bytes / 1024 / 1024).toFixed(1)} MB MVT` : `${gridCells.toLocaleString()} grid cells`}</span>`
        : "";
    statsEl.innerHTML = `<span>${s.places ?? 0} pins</span><span class="${dbClass}">${dbMb.toFixed(1)} MB</span><span>${s.jobs?.pending ?? 0} queue</span>${passLine}${bakedLine}`;
    btnToggle.textContent = scraping ? "Pause" : "Resume";
    btnToggle.classList.toggle("btn-accent", !scraping);
    btnStart.disabled = scraping || !!s.state?.storage_handbrake;
    applyBakeUi(tm);
    if (s.state?.storage_handbrake) {
      statusEl.textContent = "storage full";
      statusEl.classList.add("status-error");
    } else if (!baking) {
      statusEl.classList.remove("status-error");
      if (scraping) statusEl.textContent = "scraping";
      else if (s.pass?.total && s.pass.done === s.pass.total && !s.pass.pending) statusEl.textContent = "complete";
      else if (!p5n.hasBakedTiles()) statusEl.textContent = "idle";
    }
  }

  let wasBaking = false;

  function applyBakeUi(tm?: {
    bake_status?: string;
    bake_progress?: number;
    bake_total?: number;
    bake_error?: string | null;
    bake_phase?: string | null;
    version?: number;
    place_count?: number;
    bytes?: number;
    grid_cells?: number;
  }): void {
    const status = tm?.bake_status ?? "idle";
    baking = status === "running";
    btnBake.disabled = baking;

    if (status === "running") {
      wasBaking = true;
      const pct = tm?.bake_progress ?? 0;
      const phase = tm?.bake_phase ?? "working";
      const phaseLabel =
        phase === "grid"
          ? "indexing grid"
          : phase === "export"
            ? "exporting pins"
            : phase === "tile"
              ? "building MVT"
              : phase === "upload"
                ? "uploading"
                : "baking";
      bakeStatusEl.textContent = `${phaseLabel}… ${pct}%`;
      bakeStatusEl.className = "bake-status baking";
      statusEl.textContent = "baking PMTiles…";
      return;
    }

    if (status === "error") {
      bakeStatusEl.textContent = tm?.bake_error ? `bake failed: ${tm.bake_error}` : "bake failed";
      bakeStatusEl.className = "bake-status bake-error";
      stopBakePoll();
      wasBaking = false;
      btnBake.disabled = false;
      return;
    }

    if (wasBaking && status !== "running") {
      wasBaking = false;
      stopBakePoll();
      void onBakeComplete();
    }

    btnBake.disabled = false;
    bakeStatusEl.className = "bake-status";
    if (tm?.version && tm.version > 0) {
      const mb = tm.bytes ? `${(tm.bytes / 1024 / 1024).toFixed(1)} MB` : "";
      bakeStatusEl.textContent = `PMTiles v${tm.version} · ${(tm.place_count ?? 0).toLocaleString()} pins${mb ? ` · ${mb}` : ""}`;
    } else {
      bakeStatusEl.textContent = "";
    }
  }

  function stopBakePoll(): void {
    if (bakePollTimer) window.clearInterval(bakePollTimer);
    bakePollTimer = undefined;
  }

  function startBakePoll(): void {
    stopBakePoll();
    bakePollTimer = window.setInterval(() => void refreshStats(), 1500);
  }

  async function onBakeComplete(): Promise<void> {
    baking = false;
    stopBakePoll();
    const loaded = await p5n.reloadBakedTiles();
    statusEl.textContent = loaded ? "baked tiles loaded" : "bake done — reload page";
    await refreshStats();
  }

  btnStart.addEventListener("click", () => {
    btnStart.disabled = true;
    statusEl.textContent = "starting…";
    void post("/api/scrape/start").then(refreshStats).then(() => {
      statusEl.textContent = "scraping";
    });
  });

  btnToggle.addEventListener("click", () => {
    void post("/api/scrape/toggle").then(refreshStats).then(() => {
      statusEl.textContent = scraping ? "scraping" : "paused";
      if (!scraping) btnStart.disabled = false;
    });
  });

  btnBake.addEventListener("click", () => {
    btnBake.disabled = true;
    bakeStatusEl.textContent = "starting bake…";
    bakeStatusEl.className = "bake-status baking";
    void post("/api/tiles/bake")
      .then(async (res) => {
        if ((res as { error?: string }).error) {
          bakeStatusEl.textContent = String((res as { error?: string }).error);
          bakeStatusEl.className = "bake-status bake-error";
          btnBake.disabled = false;
          return;
        }
        baking = true;
        startBakePoll();
        await refreshStats();
      })
      .catch(() => {
        bakeStatusEl.textContent = "bake request failed";
        bakeStatusEl.className = "bake-status bake-error";
        btnBake.disabled = false;
      });
  });

  const es = new EventSource(`${API_BASE}/api/stream`);
  es.addEventListener("log", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as { message: string; created_at: string; level?: string };
    if (e.level === "pin") return;
    const line = document.createElement("div");
    line.textContent = `${e.created_at.slice(11, 19)} ${e.message}`;
    if (e.level === "error") line.className = "log-error";
    logEl.prepend(line);
    while (logEl.childElementCount > 30) logEl.lastElementChild?.remove();
  });
  es.addEventListener("place", (ev) => {
    const pin = JSON.parse((ev as MessageEvent).data) as PinFeature;
    if (!p5n.addLivePinIfVisible(pin)) return;
    statusEl.textContent = `+ ${pin.name ?? pin.id}`;
  });
  es.addEventListener("stats", (ev) => {
    const data = JSON.parse((ev as MessageEvent).data);
    if (!(data as { state?: unknown }).state) return;
    applyStats(data);
  });
  es.addEventListener("hello", () => refreshStats());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
