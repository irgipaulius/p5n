import { P5nMap, colorForType, type PinFeature } from "@p5n/sdk";
import maplibregl from "maplibre-gl";

const API_BASE = import.meta.env.DEV ? "" : "";

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="layout">
      <header class="topbar">
        <button type="button" id="btn-start" class="primary">Start scrape</button>
        <button type="button" id="btn-toggle">Pause scrape</button>
        <div class="stats" id="stats">loading…</div>
        <span class="status" id="status"></span>
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
  const statusEl = root.querySelector("#status") as HTMLElement;
  const btnStart = root.querySelector("#btn-start") as HTMLButtonElement;
  const btnToggle = root.querySelector("#btn-toggle") as HTMLButtonElement;

  const p5n = new P5nMap(mapEl, { apiBase: API_BASE, dark: true });
  p5n.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  p5n.map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-left");
  p5n.map.addControl(new maplibregl.ScaleControl(), "bottom-left");

  let pinCount = 0;
  let scraping = false;

  void (async () => {
    await p5n.tryOfflineFirst();
    await p5n.initTilesFromManifest();
    p5n.watchSystemTheme();
    const n = await p5n.loadExistingPins();
    pinCount = n;
    statusEl.textContent = n ? `${n} pins loaded` : "ready";
    await refreshStats();
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

  async function post(path: string): Promise<Record<string, unknown>> {
    const resp = await fetch(`${API_BASE}${path}`, { method: "POST" });
    return resp.json();
  }

  async function refreshStats(): Promise<void> {
    const resp = await fetch(`${API_BASE}/api/stats`);
    const s = await resp.json();
    applyStats(s);
  }

  function applyStats(stats: unknown): void {
    const s = stats as {
      places?: number;
      reviews?: number;
      jobs?: Record<string, number>;
      state?: { paused: number; max_places: number };
    };
    scraping = !s.state?.paused;
    const queue = s.jobs?.pending ?? 0;
    statsEl.innerHTML = `
      <span>places <b>${s.places ?? 0}</b></span>
      <span>queue <b>${queue}</b></span>
      <span>cap <b>${s.state?.max_places ?? "?"}</b></span>
    `;
    btnToggle.textContent = scraping ? "Pause scrape" : "Resume scrape";
    btnToggle.classList.toggle("primary", !scraping);
    btnStart.disabled = scraping;
  }

  btnStart.addEventListener("click", () => {
    btnStart.disabled = true;
    statusEl.textContent = "starting…";
    void post("/api/scrape/start")
      .then(() => refreshStats())
      .then(() => {
        statusEl.textContent = "scraping…";
      })
      .catch((err) => {
        statusEl.textContent = String(err);
        btnStart.disabled = false;
      });
  });

  btnToggle.addEventListener("click", () => {
    statusEl.textContent = scraping ? "pausing…" : "resuming…";
    void post("/api/scrape/toggle")
      .then(() => refreshStats())
      .then(() => {
        statusEl.textContent = scraping ? "scraping…" : "paused";
        if (!scraping) btnStart.disabled = false;
      })
      .catch((err) => {
        statusEl.textContent = String(err);
      });
  });

  const es = new EventSource(`${API_BASE}/api/stream`);
  es.addEventListener("log", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as { message: string; created_at: string; level?: string };
    if (e.level === "pin") return;
    const line = document.createElement("div");
    line.textContent = `${e.created_at.slice(11, 19)} ${e.message}`;
    logEl.prepend(line);
    while (logEl.childElementCount > 30) logEl.lastElementChild?.remove();
  });
  es.addEventListener("place", (ev) => {
    const pin = JSON.parse((ev as MessageEvent).data) as PinFeature;
    p5n.addLivePin(pin);
    statusEl.textContent = `live · ${pin.name ?? pin.id}`;
  });
  es.addEventListener("stats", (ev) => applyStats(JSON.parse((ev as MessageEvent).data)));
  es.addEventListener("hello", () => refreshStats());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
