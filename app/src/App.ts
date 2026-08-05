import { P5nMap, TYPE_LABELS, colorForType, type PinFeature } from "@p5n/sdk";
import maplibregl from "maplibre-gl";

const API_BASE = import.meta.env.DEV ? "" : "";

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="layout">
      <header class="topbar">
        <input type="search" id="search" placeholder="Search places, features…" autocomplete="off" />
        <button type="button" id="btn-search" class="primary">Search</button>
        <button type="button" id="btn-crawl">+10 local</button>
        <button type="button" id="btn-new">Fetch new</button>
        <button type="button" id="btn-full">Full pass</button>
        <button type="button" id="btn-cont">Resume crawl</button>
        <button type="button" id="btn-offline">Offline</button>
        <div class="stats" id="stats">loading…</div>
        <span class="progress" id="progress"></span>
      </header>
      <div class="main">
        <div id="map"></div>
        <aside class="panel" id="detail"></aside>
        <div class="log" id="log"></div>
      </div>
    </div>
  `;

  const mapEl = root.querySelector("#map") as HTMLElement;
  const statsEl = root.querySelector("#stats") as HTMLElement;
  const logEl = root.querySelector("#log") as HTMLElement;
  const detailEl = root.querySelector("#detail") as HTMLElement;
  const progressEl = root.querySelector("#progress") as HTMLElement;
  const searchInput = root.querySelector("#search") as HTMLInputElement;

  const p5n = new P5nMap(mapEl, { apiBase: API_BASE, dark: true });
  p5n.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  p5n.map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-left");
  p5n.map.addControl(new maplibregl.ScaleControl(), "bottom-left");

  void (async () => {
    await p5n.tryOfflineFirst();
    await p5n.initTilesFromManifest();
    p5n.watchSystemTheme();
    p5n.onMoveEndEnrich();
    p5n.connectLiveStream(applyStats);
  })();

  p5n.onPinClick(async (placeId) => {
    detailEl.classList.add("open");
    detailEl.innerHTML = `<h2>Place ${placeId}</h2><p>Loading…</p>`;
    try {
      const data = await p5n.placeDetail(placeId);
      detailEl.innerHTML = `<h2>${(data as { name?: string }).name ?? placeId}</h2><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    } catch (err) {
      detailEl.innerHTML = `<h2>Error</h2><pre>${escapeHtml(String(err))}</pre>`;
    }
  });

  let searchSource: maplibregl.GeoJSONSource | null = null;
  function ensureSearchLayer(): void {
    if (!p5n.map.getSource("search-results")) {
      p5n.map.addSource("search-results", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      p5n.map.addLayer({
        id: "search-results-circles",
        type: "circle",
        source: "search-results",
        paint: {
          "circle-radius": 9,
          "circle-color": "#f472b6",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });
    }
    searchSource = p5n.map.getSource("search-results") as maplibregl.GeoJSONSource;
  }

  async function runSearch(): Promise<void> {
    const q = searchInput.value.trim();
    ensureSearchLayer();
    const features: GeoJSON.Feature[] = [];
    searchSource?.setData({ type: "FeatureCollection", features });
    progressEl.textContent = "searching…";
    await p5n.search({
      q: q || undefined,
      limit: 500,
      onPin: (pin: PinFeature) => {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
          properties: { id: pin.id, name: pin.name, t: pin.t },
        });
        searchSource?.setData({ type: "FeatureCollection", features: [...features] });
        progressEl.textContent = `${features.length} results…`;
      },
    });
    progressEl.textContent = `${features.length} results`;
    if (features.length) {
      const coords = features.map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]);
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      );
      p5n.map.fitBounds(bounds, { padding: 48, maxZoom: 12 });
    }
  }

  root.querySelector("#btn-search")!.addEventListener("click", () => void runSearch());
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runSearch();
  });

  root.querySelector("#btn-crawl")!.addEventListener("click", () => post("/api/crawl"));
  root.querySelector("#btn-new")!.addEventListener("click", () => post("/api/crawl/new"));
  root.querySelector("#btn-full")!.addEventListener("click", () => post("/api/crawl/full"));
  root.querySelector("#btn-cont")!.addEventListener("click", () => post("/api/control/continuous/resume"));
  root.querySelector("#btn-offline")!.addEventListener("click", () => {
    progressEl.textContent = "downloading…";
    void p5n.downloadOffline((pct) => {
      progressEl.textContent = `offline ${pct}%`;
    }).then(() => {
      progressEl.textContent = "offline ready";
    }).catch((err) => {
      progressEl.textContent = String(err);
    });
  });

  async function post(path: string): Promise<void> {
    await fetch(`${API_BASE}${path}`, { method: "POST" });
  }

  function applyStats(stats: unknown): void {
    const s = stats as {
      places?: number;
      reviews?: number;
      jobs?: Record<string, number>;
      pass?: { pass_id: number; mode: string; done: number; total: number; continuous_paused: boolean };
      state?: { paused: number; max_places: number };
    };
    const queue = s.jobs?.pending ?? 0;
    statsEl.innerHTML = `
      <span>places <b>${s.places ?? 0}</b></span>
      <span>reviews <b>${s.reviews ?? 0}</b></span>
      <span>queue <b>${queue}</b></span>
      <span>cap <b>${s.state?.max_places ?? "?"}</b></span>
      ${s.pass?.pass_id ? `<span>pass #${s.pass.pass_id} ${s.pass.done}/${s.pass.total}</span>` : ""}
    `;
  }

  void fetch(`${API_BASE}/api/stats`)
    .then((r) => r.json())
    .then(applyStats);

  const es = new EventSource(`${API_BASE}/api/stream`);
  es.addEventListener("log", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as { message: string; created_at: string };
    const line = document.createElement("div");
    line.textContent = `${e.created_at.slice(11, 19)} ${e.message}`;
    logEl.prepend(line);
    while (logEl.childElementCount > 40) logEl.lastElementChild?.remove();
  });
  es.addEventListener("place", (ev) => {
    const pin = JSON.parse((ev as MessageEvent).data);
    p5n.addLivePin(pin);
  });
  es.addEventListener("stats", (ev) => applyStats(JSON.parse((ev as MessageEvent).data)));

  // Type filter chips
  const filterWrap = document.createElement("div");
  filterWrap.className = "type-filters";
  for (const [t, label] of Object.entries(TYPE_LABELS)) {
    const n = Number(t);
    const labelEl = document.createElement("label");
    labelEl.innerHTML = `<input type="checkbox" checked data-t="${n}" /><span style="color:${colorForType(n)}">●</span> ${label}`;
    filterWrap.appendChild(labelEl);
  }
  root.querySelector(".topbar")!.appendChild(filterWrap);

  filterWrap.addEventListener("change", () => {
    const checked = [...filterWrap.querySelectorAll<HTMLInputElement>("input:checked")].map((el) =>
      Number(el.dataset.t),
    );
    for (const suffix of ["-circles", "-symbols"]) {
      const layerId = `pins-baked${suffix}`;
      if (p5n.map.getLayer(layerId)) {
        p5n.map.setFilter(layerId, ["in", ["get", "t"], ["literal", checked]]);
      }
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
