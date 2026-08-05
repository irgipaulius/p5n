# p5n — map SDK + geo-indexed DB API

High-performance Park4Night alternative architecture:

- **`sdk/`** — framework-free TypeScript map SDK (MapLibre + PMTiles + streaming search + OPFS offline)
- **`src/`** — Cloudflare Worker: append-only crawler + read-prioritized geo API
- **`app/`** — dashboard satellite that consumes the SDK + scrape controls
- **`tiles/`** — tile bakery: D1 export → tippecanoe → PMTiles on R2

## Quick start

```bash
npm install
npm run db:reset          # wipe local D1 + apply fresh schema
npm run dev               # worker API @ :8787
npm run dev:app           # vite dashboard @ :5173 (proxies /api)
```

Open http://localhost:5173 — scraper is **idle on startup**. Click **Start scrape** to begin the Europe-wide pass; **Pause** stops immediately. Stats show pin count and live DB size (MB).

## Deploy (park5night.hyperreader.eu)

1. **Cloudflare dashboard** → Workers & Pages → Create → Connect GitHub → select `p5n` repo.
2. Build command: `npm run app:build` · Deploy command: `npx wrangler deploy`
3. **D1**: `npx wrangler d1 create p5n` → paste `database_id` into `wrangler.toml` → `npm run db:remote`
4. **R2**: create bucket `p5n-tiles`, bind as `TILES` in wrangler.toml (already configured).
5. **Custom domain**: Workers → p5n → Settings → Domains → add `park5night.hyperreader.eu` (zone `hyperreader.eu` must be on Cloudflare).
6. **Cron**: enabled in `wrangler.toml` (`*/1 * * * *`) so scraping continues overnight without the dashboard open.
7. Set production vars if needed: `REQUEST_DELAY_MS=500` (polite ~2 req/s to p4n), `TILES_PUBLIC_URL=https://park5night.hyperreader.eu`.

Storage safety: scraper auto-pauses at **4.5 GB** D1 usage (dashboard shows live MB). If hit, schema is too thick — refactor before resuming.

```bash
npm run app:build
npm run deploy
```

### Bake pin tiles (after crawling)

```bash
brew install tippecanoe    # once
npm run tiles:all
# upload out/pins-v*.pmtiles + manifest.json to R2 (see tiles/bake.mjs output)
```

## API (geo-indexed DB)

| Endpoint | Tier | Description |
|---|---|---|
| `GET /api/tiles/manifest` | 1 | PMTiles version + URL (~id+type only) |
| `GET /api/pins/bbox?west&south&east&north` | 1 | Slim pins in viewport |
| `GET /api/enrich?bbox&since=` | 2 | Lazy attrs/rating for viewport |
| `GET /api/search?q=&attrs0=&limit=` | stream | **NDJSON** — pins flush as found |
| `GET /api/places/:id` | 3 | Full detail + reviews (on-demand) |
| `GET /api/stream` | live | SSE new pins while crawling |

Reads use D1 Sessions (`first-unconstrained` replica) when available; writes are batched on primary.

## Architecture

```
Crawler (writes) → D1 places + snapshots + FTS
                        ↓ bakery
                   pins.pmtiles (R2)
                        ↓ range requests / OPFS
                   sdk/ MapLibre GPU render
                        ↑
              app/ dashboard + scrape controls
```

Three-tier loading:

1. **Base pins** — prebaked `{id, t}` in PMTiles (~5–15 MB world)
2. **Enrichment** — viewport flags/rating via `/api/enrich`
3. **Detail** — click → `/api/places/:id` (IndexedDB cached)

---

## The nerd tour (optimization techniques)

This repo is a showcase of map-data performance patterns. Each technique is used here on purpose.

### 1. Tile pyramid + viewport-only fetch

Google Maps doesn't push every pin over a socket. It pre-bakes a **spatial pyramid**; the client fetches only tiles intersecting the viewport. We do the same with PMTiles + MapLibre vector sources.

### 2. MVT internals (why bytes are tiny)

Vector tiles (Mapbox Vector Tile / protobuf):

- **Tile-local quantization**: coordinates are integers on a 4096×4096 grid per tile — sub-meter at z14, ~2 bytes per delta vs 16-byte doubles.
- **Zigzag varint delta encoding**: consecutive points stored as signed deltas; protobuf packs them tightly.
- **Per-tile dictionaries**: property keys (`id`, `t`) appear once per tile, not per feature.

### 3. PMTiles = serverless tile CDN in one file

[PMTiles](https://github.com/protomaps/PMTiles) stores the entire pyramid in **one file**:

- Tiles ordered on a **Hilbert curve** → neighboring tiles are neighboring bytes → one HTTP range read often covers a pan.
- **Clustered directories** → O(log n) lookup to byte offset.
- Served from R2 with **`Accept-Ranges`** — no tile server process.

### 4. Three-tier data loading

| Tier | Payload | When |
|---|---|---|
| PMTiles `{id,t}` | ~few bytes/pin baked | Always (pan/zoom) |
| `/api/enrich` | attrs + rating | Idle after pan |
| `/api/places/:id` | full JSON + reviews | Pin click |

Never ship megabytes when millimeters suffice.

### 5. Importance ranking per zoom

`tippecanoe --order-by=rating --drop-densest-as-needed`: at low zoom you see the **best** pins, not all 500k. Same trick Google uses for POI visibility.

### 6. Streaming NDJSON search

`/api/search` paginates D1 in chunks and **flushes each row immediately** as NDJSON. The SDK parses line-by-line — first pins hit the map before the query finishes. No "wait for 5000 rows" waterfall.

### 7. Attribute bitmasks in SQLite

32 facility flags → two `INTEGER` columns (`attrs0`, `attrs1`). Feature filter: `WHERE (attrs0 & ?) = ?` — compact storage, fast bitwise tests, generic taxonomy via `attribute_defs` for future sources (iOverlander, etc.).

### 8. Geohash prefix indexing

No R-Tree in D1 — `geohash4` / `geohash6` prefix columns + lat/lng bbox for viewport queries.

### 9. Read replicas beat write storms

Map/API reads → `DB.withSession('first-unconstrained')` (nearest replica). Crawler writes → primary in small `db.batch()` transactions. **Scraping can be slow; reads must not wait.**

### 10. GPU expression filters + feature-state

Type checkboxes → `map.setFilter(['in', ['get','t'], ...])` — runs on GPU against tiles already in memory. Enrichment attaches via **`feature-state`** + `promoteId: 'id'` — no vertex buffer re-upload on hover/select.

### 11. Circles below z12, symbols above

Symbol layers run **collision detection** — the classic map jank source. Circles skip collision entirely; we use colored circles at low zoom (cheapest GPU primitive).

### 12. OPFS vs IndexedDB for big blobs

Offline PMTiles live in **Origin Private File System** — near-native random access, no structured-clone tax, never loaded fully into RAM. Place details use IndexedDB (small JSON blobs).

### 13. HTTP/3 is already binary

"Hypertext sounds slower than bytes" — HTTP/2/3 are **binary** (QUIC frames, QPACK headers). We get multiplexed streams **plus** immutable caching at browser → service worker → CDN. Raw sockets can't compete for tile workloads.

### 14. Prefetch + immutable artifacts

Versioned `pins-v{N}.pmtiles` with `Cache-Control: immutable` — repeat visits render from disk before the network answers. Service worker caches app shell for offline-first dashboard.

---

## Deploy

See **Deploy (park5night.hyperreader.eu)** in Quick start above.

```bash
npm run app:build
npx wrangler d1 create p5n          # once — set database_id in wrangler.toml
npm run db:remote
npx wrangler deploy
```

## Legacy

Python/SQLite prototype: [`legacy/`](legacy/).
