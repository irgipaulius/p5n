export function renderDashboard(stats: Record<string, unknown>, events: unknown[]): string {
  const state = (stats.state || {}) as Record<string, unknown>;
  const jobs = (stats.jobs || {}) as Record<string, number>;
  const eventRows = (events as Array<Record<string, unknown>>)
    .map((e) => `<div class="${esc(e.level)}" data-id="${esc(e.id)}">${esc(e.created_at)} · ${esc(e.message)}</div>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>p5n · live map</title>
  <link href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <style>
    :root {
      --bg: #0f1419; --panel: #141c24; --text: #e7ecf1; --muted: #8b9aab;
      --accent: #3d9a78; --border: #2a3542;
      --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans: "Segoe UI", system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; font-family: var(--sans); color: var(--text); background: var(--bg); }
    body { display: grid; grid-template-rows: auto 1fr; }
    header {
      display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;
      padding: .75rem 1rem; border-bottom: 1px solid var(--border); background: #0c1117; z-index: 2;
    }
    h1 { margin: 0; font-size: 1.05rem; letter-spacing: .04em; }
    h1 span { color: var(--accent); }
    .live { display: inline-flex; align-items: center; gap: .35rem; margin-left: .6rem; font-size: .72rem; color: var(--muted); }
    .live i { width: 7px; height: 7px; border-radius: 50%; background: #555; display: inline-block; }
    .live.on i { background: #3d9a78; box-shadow: 0 0 8px #3d9a78; }
    .stats-inline { display: flex; gap: .9rem; flex-wrap: wrap; color: var(--muted); font-size: .78rem; font-family: var(--mono); }
    .stats-inline b { color: var(--text); font-weight: 600; }
    .controls button {
      background: var(--panel); color: var(--text); border: 1px solid var(--border);
      padding: .4rem .75rem; margin-left: .25rem; border-radius: 4px; cursor: pointer; font-size: .85rem;
    }
    .controls button.primary { background: #204536; border-color: var(--accent); }
    .controls button:disabled { opacity: .6; cursor: wait; }
    .layout { display: grid; grid-template-columns: 1fr 340px; min-height: 0; height: 100%; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; grid-template-rows: 55vh 1fr; } }
    #map { width: 100%; height: 100%; min-height: 420px; background: #1a2330; }
    aside {
      border-left: 1px solid var(--border); background: var(--panel);
      display: flex; flex-direction: column; min-height: 0;
    }
    aside h2 {
      margin: 0; padding: .7rem .9rem; font-size: .72rem; text-transform: uppercase;
      letter-spacing: .08em; color: var(--muted); border-bottom: 1px solid var(--border);
    }
    #events {
      font-family: var(--mono); font-size: .68rem; max-height: 28%; overflow: auto;
      padding: .5rem .8rem; border-bottom: 1px solid var(--border); color: #c5d0db;
    }
    #events .error { color: #e07a5f; }
    #detail {
      flex: 1; overflow: auto; padding: .8rem; font-family: var(--mono); font-size: .72rem;
      white-space: pre-wrap; word-break: break-word; color: #d5dee8;
    }
    #detail.empty { color: var(--muted); font-family: var(--sans); font-size: .85rem; }
    .maplibregl-popup-content {
      background: #101820; color: var(--text); border: 1px solid var(--border);
      border-radius: 6px; padding: .55rem .7rem; font-size: .8rem; max-width: 260px;
    }
    .maplibregl-popup-anchor-bottom .maplibregl-popup-tip { border-top-color: #101820; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1><span>p5n</span> map <span class="live" id="live"><i></i> connecting</span></h1>
      <div class="stats-inline">
        <span>archive <b id="s-places">${esc(stats.known_places)}</b></span>
        <span>reviews <b id="s-reviews">${esc(stats.review_snapshots)}</b></span>
        <span>raw <b id="s-bytes">${esc(stats.raw_bytes)}</b> B</span>
        <span>queue <b id="s-jobs">${esc(jobs.pending || 0)}</b></span>
        <span>pass <b id="s-pass">—</b></span>
        <span>continuous <b id="s-cont">paused</b></span>
      </div>
    </div>
    <div class="controls">
      <button class="primary" onclick="post('/api/crawl/full')" title="Sweep Europe grid; new + refresh known. Never deletes.">Full pass</button>
      <button onclick="post('/api/crawl/new')" title="Only discover spots we don't have yet">Fetch new</button>
      <button id="contBtn" onclick="toggleContinuous()">Resume continuous</button>
      <button onclick="post('/api/crawl')" title="Small +10 near default point">+10 local</button>
    </div>
  </header>
  <div class="layout">
    <div id="map"></div>
    <aside>
      <h2>Events</h2>
      <div id="events">${eventRows || "<div>no events yet</div>"}</div>
      <h2>Pin detail</h2>
      <div id="detail" class="empty">Click a pin to load the full stored DB row.</div>
    </aside>
  </div>
  <script>
    const pinsById = new Map();
    let didInitialFit = false;

    async function post(url) {
      const r = await fetch(url, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) alert(j.error || r.statusText);
      return j;
    }

    async function toggleContinuous() {
      const running = document.getElementById('s-cont').textContent === 'running';
      await post(running ? '/api/control/continuous/pause' : '/api/control/continuous/resume');
    }

    const TYPE_COLORS = {
      C: '#3d9a78', F: '#c4a35a', P: '#6b8cae', PN: '#5a9e6f', PJ: '#7a9bb8',
      OR: '#b87a9a', AR: '#8a7ab8', AC: '#7ab8a8', ACC_PR: '#9a8a6b', PSS: '#888',
    };

    const map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {
          carto: {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '© OpenStreetMap © CARTO',
          },
        },
        layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
      },
      center: [19.641, 41.689],
      zoom: 9,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    function toFeature(p) {
      return {
        type: 'Feature',
        id: Number(p.id) || undefined,
        geometry: { type: 'Point', coordinates: [Number(p.lng), Number(p.lat)] },
        properties: {
          id: String(p.id),
          name: p.name || '',
          code: p.code || '',
          rating: p.rating,
          reviews: p.reviews || 0,
          color: TYPE_COLORS[p.code] || '#ffdd57',
        },
      };
    }

    function pushPinsToMap() {
      const src = map.getSource('places');
      if (!src) return;
      src.setData({ type: 'FeatureCollection', features: [...pinsById.values()] });
    }

    function upsertPin(p, { animate = true } = {}) {
      if (p.lat == null || p.lng == null) return;
      const id = String(p.id);
      const isNew = !pinsById.has(id);
      pinsById.set(id, toFeature(p));
      pushPinsToMap();
      if (animate && isNew && map.getSource('places')) {
        try {
          map.setFeatureState({ source: 'places', id: Number(id) }, { pop: 1 });
          setTimeout(() => {
            try { map.setFeatureState({ source: 'places', id: Number(id) }, { pop: 0 }); } catch (_) {}
          }, 700);
        } catch (_) {}
      }
      document.getElementById('s-places').textContent = String(pinsById.size);
    }

    function applyStats(s) {
      if (!s) return;
      document.getElementById('s-places').textContent = String(s.known_places ?? pinsById.size);
      document.getElementById('s-reviews').textContent = String(s.review_snapshots ?? '');
      document.getElementById('s-bytes').textContent = String(s.raw_bytes ?? '');
      const jobs = s.jobs || {};
      document.getElementById('s-jobs').textContent = String(jobs.pending || 0);
      const pass = s.pass || {};
      const contPaused = !pass.mode || !!pass.continuous_paused;
      const contEl = document.getElementById('s-cont');
      const contBtn = document.getElementById('contBtn');
      if (pass.mode) {
        document.getElementById('s-pass').textContent =
          '#' + pass.pass_id + ' ' + pass.mode + ' ' + (pass.done || 0) + '/' + (pass.total || 0);
        contEl.textContent = contPaused ? 'paused' : 'running';
        contBtn.textContent = contPaused ? 'Resume continuous' : 'Pause continuous';
      } else {
        document.getElementById('s-pass').textContent = 'idle';
        contEl.textContent = 'paused';
        contBtn.textContent = 'Resume continuous';
      }
    }

    function prependLog(e) {
      const box = document.getElementById('events');
      const div = document.createElement('div');
      div.className = e.level || '';
      div.textContent = (e.created_at || '') + ' · ' + (e.message || '');
      box.prepend(div);
      while (box.children.length > 80) box.removeChild(box.lastChild);
    }

    function ensureLayers() {
      if (map.getSource('places')) return;
      map.addSource('places', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'id',
        // NO clustering — every pin stays distinct at world zoom
      });
      map.addLayer({
        id: 'pins',
        type: 'circle',
        source: 'places',
        paint: {
          'circle-color': [
            'case',
            ['==', ['feature-state', 'pop'], 1], '#ffffff',
            ['get', 'color']
          ],
          'circle-radius': [
            'case',
            ['==', ['feature-state', 'pop'], 1], 14,
            5
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#111',
          'circle-opacity': 0.95,
        },
      });

      map.on('click', 'pins', async (e) => {
        const f = e.features && e.features[0];
        if (!f) return;
        const id = f.properties.id;
        const coords = f.geometry.coordinates.slice();
        const detail = document.getElementById('detail');
        detail.className = '';
        detail.textContent = 'Loading ' + id + '…';
        new maplibregl.Popup()
          .setLngLat(coords)
          .setHTML('<b>' + (f.properties.name || id) + '</b><br/>#' + id +
            (f.properties.code ? ' · ' + f.properties.code : ''))
          .addTo(map);
        try {
          const row = await fetch('/api/places/' + encodeURIComponent(id)).then(r => r.json());
          detail.textContent = JSON.stringify(row, null, 2);
        } catch (err) {
          detail.textContent = String(err);
        }
      });
      map.on('mouseenter', 'pins', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'pins', () => { map.getCanvas().style.cursor = ''; });
    }

    async function loadInitialPins() {
      ensureLayers();
      const pins = await fetch('/api/places/geo').then(r => r.json());
      if (!Array.isArray(pins)) return;
      for (const p of pins) upsertPin(p, { animate: false });
      // Fit once on first paint only — never again when ants arrive
      if (!didInitialFit && pinsById.size) {
        const bounds = new maplibregl.LngLatBounds();
        for (const f of pinsById.values()) bounds.extend(f.geometry.coordinates);
        map.fitBounds(bounds, { padding: 60, maxZoom: 12 });
        didInitialFit = true;
      }
      map.resize();
    }

    function connectSSE() {
      const live = document.getElementById('live');
      const es = new EventSource('/api/stream');
      es.addEventListener('hello', () => {
        live.classList.add('on');
        live.childNodes[1].textContent = ' live';
      });
      es.addEventListener('place', (msg) => {
        const p = JSON.parse(msg.data);
        upsertPin(p, { animate: true });
      });
      es.addEventListener('stats', (msg) => applyStats(JSON.parse(msg.data)));
      es.addEventListener('log', (msg) => prependLog(JSON.parse(msg.data)));
      es.addEventListener('ping', () => {
        live.classList.add('on');
      });
      es.onerror = () => {
        live.classList.remove('on');
        live.childNodes[1].textContent = ' reconnecting';
      };
    }

    map.on('load', async () => {
      map.resize();
      await loadInitialPins();
      connectSSE();
    });
    window.addEventListener('resize', () => map.resize());
  </script>
</body>
</html>`;
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
