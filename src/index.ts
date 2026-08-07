import { handleCrawlChainRequest, kickCrawlChain, runCrawlBurst, runCrawlLoop } from "./crawl";
import {
  bumpMaxPlaces,
  commentsUrl,
  crawlWorkRemaining,
  emit,
  enqueueJob,
  eventsSince,
  fetchJson,
  getPlaceFull,
  getState,
  getStats,
  ingestReviews,
  listPlaces,
  listPlacesGeo,
  listPlacesGeoSince,
  maxEventId,
  maybeCompletePass,
  placesCount,
  queueNextDiscoveryCells,
  readDb,
  recentEvents,
  reclaimCrawlLease,
  reclaimStaleLeases,
  reviewsFetched,
  setContinuousPaused,
  setPaused,
  startPass,
  tryAcquireCrawlLease,
  writeDb,
} from "./db";
import {
  handleAttributes,
  handleBboxPins,
  handleGridPins,
  handleEnrich,
  handleIpGeo,
  handleStreamingSearch,
  handleTileManifest,
  handleTilePins,
} from "./geo-api";
import { buildEuropeGrid } from "./placeTypes";
import { pauseScrape, resumeScrape, startScrape } from "./scrape";
import { getTileBakeStatus, listTileChunks, readTileBlob, runTileBake, startTileBake } from "./tile-bake";
import { ensureSchema } from "./schema-ensure";
import type { CommentApi, Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await ensureSchema(writeDb(env));

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // Static app assets (built dashboard at app/dist root)
      if (env.ASSETS && (pathname.startsWith("/assets/") || pathname === "/sw.js" || pathname === "/manifest.webmanifest")) {
        return env.ASSETS.fetch(request);
      }

      if (request.method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
        if (env.ASSETS) {
          const assetUrl = new URL(request.url);
          assetUrl.pathname = "/index.html";
          return env.ASSETS.fetch(new Request(assetUrl, request));
        }
        return serveAppIndex();
      }

      if (request.method === "GET" && pathname === "/api/stats") {
        return json(await getStats(writeDb(env)));
      }

      if (request.method === "GET" && pathname === "/api/pins/bbox") {
        return handleBboxPins(env, url);
      }

      if (request.method === "GET" && pathname === "/api/pins/grid") {
        return handleGridPins(env, url);
      }

      if (request.method === "GET" && pathname === "/api/pins/tiles") {
        return handleTilePins(env, url);
      }

      if (request.method === "GET" && pathname === "/api/geo/ip") {
        return handleIpGeo(request);
      }

      if (request.method === "GET" && pathname === "/api/enrich") {
        return handleEnrich(env, url);
      }

      if (request.method === "GET" && pathname === "/api/search") {
        return handleStreamingSearch(env, url);
      }

      if (request.method === "GET" && pathname === "/api/attributes") {
        return handleAttributes(env);
      }

      if (request.method === "GET" && pathname === "/api/tiles/manifest") {
        return handleTileManifest(env, request);
      }

      if (request.method === "GET" && pathname === "/api/tiles/bake/status") {
        const status = await getTileBakeStatus(env);
        return json(status ?? { bake_status: "idle" });
      }

      if (request.method === "GET" && pathname === "/api/tiles/chunks") {
        const ids = (url.searchParams.get("ids") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 24);
        const chunks = await listTileChunks(env, ids, request);
        return json({ chunks }, 200, { "cache-control": "public, max-age=300" });
      }

      if (request.method === "POST" && pathname === "/api/tiles/bake") {
        const start = await startTileBake(env);
        if (!start.ok) return json(start, start.error === "bake already running" ? 409 : 503);
        ctx.waitUntil(runTileBake(env));
        await emit(writeDb(env), "tile bake queued from dashboard");
        return json({ ok: true, started: true });
      }

      if (request.method === "GET" && pathname === "/api/places/geo") {
        return json(await listPlacesGeo(env), 200, { "cache-control": "no-store" });
      }

      if (request.method === "GET" && pathname === "/api/places") {
        const limit = Number(url.searchParams.get("limit") || 50);
        return json(await listPlaces(readDb(env), limit));
      }

      const placeMatch = pathname.match(/^\/api\/places\/([^/]+)$/);
      if (request.method === "GET" && placeMatch) {
        const placeId = decodeURIComponent(placeMatch[1]);
        const wdb = writeDb(env);
        if (!(await reviewsFetched(wdb, placeId))) {
          try {
            const reviewsUrl = commentsUrl(placeId);
            const { status, body, data } = await fetchJson(env, reviewsUrl);
            const parsed = data as { status?: string; commentaires?: CommentApi[] };
            if (parsed.status === "OK") {
              await ingestReviews(wdb, placeId, reviewsUrl, status, body, parsed.commentaires ?? []);
              await emit(wdb, `on-demand reviews for ${placeId}`);
            }
          } catch (err) {
            await emit(
              wdb,
              `on-demand reviews failed for ${placeId}: ${err instanceof Error ? err.message : err}`,
              "error",
            );
          }
        }
        const includeReviews = url.searchParams.get("reviews") === "1";
        const row = await getPlaceFull(env, placeId, { includeReviews });
        if (!row) return json({ error: "not found" }, 404);
        return json(row, 200, { "cache-control": "public, max-age=60" });
      }

      if (request.method === "GET" && pathname.startsWith("/tiles/")) {
        return serveTile(request, env, pathname.slice("/tiles/".length));
      }

      if (request.method === "GET" && pathname === "/api/events") {
        return json(await recentEvents(readDb(env), Number(url.searchParams.get("limit") || 50)));
      }

      if (request.method === "GET" && pathname === "/api/stream") {
        return sseStream(env);
      }

      if (request.method === "POST" && pathname === "/api/scrape/start") {
        const result = await startScrape(env);
        kickCrawlChain(env, ctx);
        await emit(
          writeDb(env),
          result.resumed
            ? `scrape resumed — pass #${result.pass_id}`
            : `scrape started — Europe pass #${result.pass_id} (${result.cells} cells)`,
        );
        return json({ ok: true, ...result });
      }

      if (request.method === "POST" && pathname === "/api/scrape/pause") {
        await pauseScrape(env);
        await emit(writeDb(env), "scrape paused — no more downloads");
        return json({ ok: true, paused: true });
      }

      if (request.method === "POST" && pathname === "/api/scrape/resume") {
        const result = await resumeScrape(env);
        kickCrawlChain(env, ctx);
        await emit(writeDb(env), "scrape resumed");
        return json({ ok: true, ...result });
      }

      if (request.method === "POST" && pathname === "/api/scrape/toggle") {
        const state = await getState(readDb(env));
        if (state.paused) {
          const result = await resumeScrape(env);
          kickCrawlChain(env, ctx);
          await emit(writeDb(env), "scrape resumed");
          return json({ ok: true, ...result, action: "resume" });
        }
        await pauseScrape(env);
        await emit(writeDb(env), "scrape paused — no more downloads");
        return json({ ok: true, paused: true, action: "pause" });
      }

      if (request.method === "POST" && pathname === "/api/crawl") {
        const batch = Number(env.MAX_PLACES || 10);
        const known = await placesCount(writeDb(env));
        await bumpMaxPlaces(writeDb(env), known + batch);
        const lat = Number(env.DEFAULT_LAT || 41.688908);
        const lng = Number(env.DEFAULT_LNG || 19.641004);
        await reclaimStaleLeases(writeDb(env));
        await enqueueJob(
          writeDb(env),
          "filter_cell",
          { lat, lng, mode: "new_only" },
          `filter:${lat.toFixed(5)}:${lng.toFixed(5)}:${known}:${Date.now()}`,
        );
        await emit(writeDb(env), `crawl +${batch} near point (cap → ${known + batch})`);
        return json({ ok: true, started: true, cap: known + batch, batch });
      }

      if (request.method === "POST" && pathname === "/api/crawl/full") {
        const cells = buildEuropeGrid(1);
        const { passId, cells: n } = await startPass(writeDb(env), "full", cells);
        await reclaimStaleLeases(writeDb(env));
        await queueNextDiscoveryCells(writeDb(env), 5);
        await emit(writeDb(env), `full pass #${passId} started — ${n} cells (append-only archive)`);
        return json({ ok: true, pass_id: passId, cells: n, mode: "full" });
      }

      if (request.method === "POST" && pathname === "/api/crawl/new") {
        const cells = buildEuropeGrid(1);
        const { passId, cells: n } = await startPass(writeDb(env), "new_only", cells);
        await reclaimStaleLeases(writeDb(env));
        await queueNextDiscoveryCells(writeDb(env), 5);
        await emit(writeDb(env), `fetch-new pass #${passId} started — ${n} cells (unknowns only)`);
        return json({ ok: true, pass_id: passId, cells: n, mode: "new_only" });
      }

      if (request.method === "POST" && pathname === "/api/control/continuous/pause") {
        await setContinuousPaused(writeDb(env), true);
        await emit(writeDb(env), "continuous crawl paused — resume will continue this pass");
        return json({ ok: true, continuous_paused: true });
      }

      if (request.method === "POST" && pathname === "/api/control/continuous/resume") {
        await setContinuousPaused(writeDb(env), false);
        await reclaimStaleLeases(writeDb(env));
        await queueNextDiscoveryCells(writeDb(env), 5);
        await emit(writeDb(env), "continuous crawl resumed");
        return json({ ok: true, continuous_paused: false });
      }

      if (request.method === "POST" && pathname === "/api/tick") {
        const result = await runCrawlLoop(env, { seed: true, maxSteps: 5 });
        return json({ ok: true, ...result });
      }

      if (request.method === "POST" && pathname === "/api/control/pause") {
        await setPaused(writeDb(env), true);
        await emit(writeDb(env), "paused via dashboard");
        return json({ ok: true, paused: true });
      }

      if (request.method === "POST" && pathname === "/api/control/resume") {
        await setPaused(writeDb(env), false);
        await emit(writeDb(env), "resumed via dashboard");
        return json({ ok: true, paused: false });
      }

      if (request.method === "POST" && pathname.startsWith("/api/control/rescrape/")) {
        const placeId = pathname.split("/").pop()!;
        const jid = await enqueueJob(writeDb(env), "rescrape_place", { place_id: placeId });
        await emit(writeDb(env), `enqueued rescrape ${placeId}`, "info", { job_id: jid });
        return json({ ok: true, job_id: jid });
      }

      if (request.method === "POST" && pathname === "/api/internal/crawl-chain") {
        return handleCrawlChainRequest(request, env, ctx);
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = writeDb(env);
    await ensureSchema(db);
    const state = await getState(db);
    if (state.paused || state.storage_handbrake) return;
    await reclaimStaleLeases(db);
    await reclaimCrawlLease(db);
    await queueNextDiscoveryCells(db, 24);
    if (!(await crawlWorkRemaining(db))) return;
    kickCrawlChain(env, ctx);
  },
} satisfies ExportedHandler<Env>;

function sseStream(env: Env): Response {
  let closed = false;
  const geoCursor = { at: new Date(0).toISOString(), id: "" };
  let lastFullStatsAt = 0;
  const FULL_STATS_MS = 30_000;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      let afterEvent = await maxEventId(writeDb(env));
      send("hello", { geoCursor, afterEvent });
      send("stats", await getStats(writeDb(env)));
      lastFullStatsAt = Date.now();

      while (!closed) {
        try {
          const places = await listPlacesGeoSince(env, geoCursor);
          for (const p of places) {
            geoCursor.at = p.updated_at;
            geoCursor.id = p.id;
            send("place", p);
          }

          const evs = await eventsSince(readDb(env), afterEvent, 50);
          for (const e of evs) {
            afterEvent = Math.max(afterEvent, Number((e as { id: number }).id));
            const row = e as { level: string; meta_json?: string | null };
            if (row.level === "pin" && row.meta_json) {
              try {
                const meta = JSON.parse(row.meta_json) as { pin?: unknown };
                if (meta.pin) send("place", meta.pin);
              } catch {
                /* skip bad meta */
              }
              continue;
            }
            send("log", e);
          }

          const now = Date.now();
          if (places.length || evs.length) {
            const lite = now - lastFullStatsAt < FULL_STATS_MS;
            send("stats", await getStats(writeDb(env), { lite }));
            if (!lite) lastFullStatsAt = now;
          } else {
            send("ping", { t: now });
          }

          await new Promise((r) => setTimeout(r, places.length ? 100 : 2000));
        } catch (err) {
          send("error", { message: err instanceof Error ? err.message : String(err) });
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

async function serveTile(request: Request, env: Env, key: string): Promise<Response> {
  const blob = await readTileBlob(env, key);
  if (!blob) return json({ error: "not found" }, 404);

  const headers = new Headers();
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("accept-ranges", "bytes");
  headers.set("content-type", "application/vnd.pmtiles");

  const range = request.headers.get("Range");
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : blob.bytes - 1;
      if (start <= end && end < blob.bytes) {
        const slice = blob.data.slice(start, end + 1);
        headers.set("content-range", `bytes ${start}-${end}/${blob.bytes}`);
        headers.set("content-length", String(slice.byteLength));
        return new Response(slice, { status: 206, headers });
      }
    }
  }

  headers.set("content-length", String(blob.bytes));
  return new Response(blob.data, { headers });
}

function serveAppIndex(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>p5n dashboard</title>
  <script type="module" crossorigin src="/assets/index.js"></script>
  <link rel="stylesheet" crossorigin href="/assets/index.css">
</head>
<body>
  <div id="root"></div>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function serveAppAsset(pathname: string): Promise<Response> {
  // Built assets are served from R2 or embedded fallback in dev via vite proxy
  return json({ error: "build app first: npm run app:build", path: pathname }, 404);
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
