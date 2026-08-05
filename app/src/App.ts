import { P5nMap, TYPE_LABELS, colorForType, type PinFeature } from "@p5n/sdk";
import maplibregl from "maplibre-gl";

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

      <div class="float float-search glass">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C8.01 14 6 11.99 6 9.5S8.01 5 10.5 5 15 7.01 15 9.5 12.99 14 10.5 14z"/></svg>
        <input type="search" id="search" placeholder="Search places, cities, features…" autocomplete="off" />
        <button type="button" id="btn-search" class="btn btn-accent">Search</button>
        <span class="search-meta" id="search-meta"></span>
      </div>

      <div class="float float-scrape glass">
        <button type="button" id="btn-start" class="btn btn-accent">Start scrape</button>
        <button type="button" id="btn-toggle" class="btn">Pause</button>
        <div class="stats" id="stats">…</div>
        <span class="status" id="status"></span>
      </div>

      <button type="button" class="float float-filters-btn glass" id="btn-filters" aria-expanded="false">
        <svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>
        Filters
      </button>

      <aside class="float float-drawer glass" id="drawer" aria-hidden="true">
        <header class="drawer-head">
          <h2>Filters</h2>
          <button type="button" class="btn-icon" id="btn-close-drawer" aria-label="Close">✕</button>
        </header>
        <section class="drawer-section">
          <h3>Place type</h3>
          <div class="chip-grid" id="type-filters"></div>
        </section>
        <section class="drawer-section">
          <h3>Facilities & features</h3>
          <div class="chip-grid" id="attr-filters"></div>
        </section>
        <footer class="drawer-foot">
          <button type="button" class="btn" id="btn-clear-filters">Clear all</button>
          <button type="button" class="btn btn-accent" id="btn-apply-filters">Apply</button>
        </footer>
      </aside>

      <aside class="float float-detail glass" id="detail"></aside>
      <div class="float float-log glass" id="log"></div>
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
  const drawer = root.querySelector("#drawer") as HTMLElement;
  const btnFilters = root.querySelector("#btn-filters") as HTMLButtonElement;
  const typeFiltersEl = root.querySelector("#type-filters") as HTMLElement;
  const attrFiltersEl = root.querySelector("#attr-filters") as HTMLElement;

  const p5n = new P5nMap(mapEl, { apiBase: API_BASE, dark: true });
  p5n.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  p5n.map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "bottom-right");
  p5n.map.addControl(new maplibregl.ScaleControl(), "bottom-left");

  let scraping = false;
  let attributes: AttributeDef[] = [];
  const selectedTypes = new Set(Object.keys(TYPE_LABELS).map(Number));
  const selectedAttrs = new Set<string>();

  void (async () => {
    await p5n.whenReady();
    await p5n.tryOfflineFirst();
    await p5n.initTilesFromManifest();
    p5n.watchSystemTheme();
    p5n.onMoveEndEnrich();
    const n = await p5n.loadExistingPins();
    statusEl.textContent = n ? `${n} pins` : "ready";
    p5n.filterTypes([...selectedTypes]);
    await refreshStats();
    await loadAttributes();
    buildTypeFilters();
    buildAttrFilters();
  })();

  p5n.onPinClick(async (placeId) => {
    detailEl.classList.add("open");
    detailEl.innerHTML = `<header class="detail-head"><h2>Place ${placeId}</h2><button class="btn-icon" id="btn-close-detail">✕</button></header><p class="muted">Loading…</p>`;
    detailEl.querySelector("#btn-close-detail")?.addEventListener("click", () => detailEl.classList.remove("open"));
    try {
      const data = await p5n.placeDetail(placeId);
      detailEl.innerHTML = `<header class="detail-head"><h2>${escapeHtml(String((data as { name?: string }).name ?? placeId))}</h2><button class="btn-icon" id="btn-close-detail">✕</button></header><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
      detailEl.querySelector("#btn-close-detail")?.addEventListener("click", () => detailEl.classList.remove("open"));
    } catch (err) {
      detailEl.innerHTML = `<header class="detail-head"><h2>Error</h2><button class="btn-icon" id="btn-close-detail">✕</button></header><pre>${escapeHtml(String(err))}</pre>`;
      detailEl.querySelector("#btn-close-detail")?.addEventListener("click", () => detailEl.classList.remove("open"));
    }
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
      chip.innerHTML = `<input type="checkbox" checked data-t="${n}" /><span class="dot" style="background:${colorForType(n)}"></span>${label}`;
      chip.querySelector("input")!.addEventListener("change", (e) => {
        const on = (e.target as HTMLInputElement).checked;
        chip.classList.toggle("active", on);
        if (on) selectedTypes.add(n);
        else selectedTypes.delete(n);
        p5n.filterTypes(selectedTypes.size ? [...selectedTypes] : []);
      });
      typeFiltersEl.appendChild(chip);
    }
  }

  function buildAttrFilters(): void {
    attrFiltersEl.innerHTML = "";
    for (const attr of attributes) {
      const chip = document.createElement("label");
      chip.className = "chip";
      chip.innerHTML = `<input type="checkbox" data-key="${attr.key}" data-col="${attr.column_name}" data-bit="${attr.bit_index}" /><span>${attr.label}</span>`;
      chip.querySelector("input")!.addEventListener("change", (e) => {
        const on = (e.target as HTMLInputElement).checked;
        chip.classList.toggle("active", on);
        if (on) selectedAttrs.add(attr.key);
        else selectedAttrs.delete(attr.key);
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

  async function runSearch(): Promise<void> {
    const q = searchInput.value.trim();
    const { attrs0, attrs1 } = attrMasks();
    const results: PinFeature[] = [];
    p5n.clearSearchResults();
    searchMeta.textContent = "searching…";
    await p5n.search({
      q: q || undefined,
      attrs0,
      attrs1,
      limit: 500,
      onPin: (pin) => {
        results.push(pin);
        p5n.setSearchResults(results);
        searchMeta.textContent = `${results.length}…`;
      },
    });
    searchMeta.textContent = `${results.length} results`;
    if (results.length) {
      const lngs = results.map((p) => p.lng);
      const lats = results.map((p) => p.lat);
      p5n.map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: 80, maxZoom: 12 },
      );
    }
  }

  async function applyFeatureFilters(): Promise<void> {
    if (selectedAttrs.size === 0) {
      p5n.clearSearchResults();
      searchMeta.textContent = "";
      return;
    }
    await runSearch();
  }

  root.querySelector("#btn-search")!.addEventListener("click", () => void runSearch());
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runSearch();
  });

  btnFilters.addEventListener("click", () => {
    const open = drawer.classList.toggle("open");
    btnFilters.setAttribute("aria-expanded", String(open));
    drawer.setAttribute("aria-hidden", String(!open));
  });
  root.querySelector("#btn-close-drawer")!.addEventListener("click", () => {
    drawer.classList.remove("open");
    btnFilters.setAttribute("aria-expanded", "false");
    drawer.setAttribute("aria-hidden", "true");
  });
  root.querySelector("#btn-apply-filters")!.addEventListener("click", () => {
    void applyFeatureFilters();
    drawer.classList.remove("open");
  });
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
    p5n.filterTypes([...selectedTypes]);
    p5n.clearSearchResults();
    searchMeta.textContent = "";
    searchInput.value = "";
  });

  async function post(path: string): Promise<Record<string, unknown>> {
    const resp = await fetch(`${API_BASE}${path}`, { method: "POST" });
    return resp.json();
  }

  async function refreshStats(): Promise<void> {
    const resp = await fetch(`${API_BASE}/api/stats`);
    applyStats(await resp.json());
  }

  function applyStats(stats: unknown): void {
    const s = stats as {
      places?: number;
      jobs?: Record<string, number>;
      state?: { paused: number; max_places: number };
    };
    scraping = !s.state?.paused;
    statsEl.innerHTML = `<span>${s.places ?? 0} places</span><span>${s.jobs?.pending ?? 0} queue</span>`;
    btnToggle.textContent = scraping ? "Pause" : "Resume";
    btnToggle.classList.toggle("btn-accent", !scraping);
    btnStart.disabled = scraping;
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

  const es = new EventSource(`${API_BASE}/api/stream`);
  es.addEventListener("log", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as { message: string; created_at: string; level?: string };
    if (e.level === "pin") return;
    const line = document.createElement("div");
    line.textContent = `${e.created_at.slice(11, 19)} ${e.message}`;
    logEl.prepend(line);
    while (logEl.childElementCount > 20) logEl.lastElementChild?.remove();
  });
  es.addEventListener("place", (ev) => {
    const pin = JSON.parse((ev as MessageEvent).data) as PinFeature;
    p5n.addLivePin(pin);
    statusEl.textContent = `+ ${pin.name ?? pin.id}`;
  });
  es.addEventListener("stats", (ev) => applyStats(JSON.parse((ev as MessageEvent).data)));
  es.addEventListener("hello", () => refreshStats());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
