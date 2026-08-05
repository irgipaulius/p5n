import { processOneJob, runCrawlLoop } from "./crawl";
import {
  bumpMaxPlaces,
  commentsUrl,
  emit,
  enqueueJob,
  eventsSince,
  fetchJson,
  getPlaceFull,
  getStats,
  ingestReviews,
  knownPlacesCount,
  listPlaces,
  listPlacesGeo,
  listPlacesGeoSince,
  maxEventId,
  maxSnapshotId,
  maybeCompletePass,
  queueNextDiscoveryCells,
  recentEvents,
  reclaimStaleLeases,
  reviewsFetched,
  setContinuousPaused,
  setPaused,
  startPass,
} from "./db";
import { renderDashboard } from "./dashboard";
import { buildEuropeGrid } from "./placeTypes";
import type { CommentApi, Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === "GET" && pathname === "/") {
        const [stats, events] = await Promise.all([getStats(env.DB), recentEvents(env.DB, 40)]);
        return html(renderDashboard(stats as unknown as Record<string, unknown>, events));
      }

      if (request.method === "GET" && pathname === "/api/stats") {
        return json(await getStats(env.DB));
      }

      if (request.method === "GET" && pathname === "/api/places/geo") {
        return json(await listPlacesGeo(env.DB), 200, { "cache-control": "no-store" });
      }

      if (request.method === "GET" && pathname === "/api/places") {
        const limit = Number(url.searchParams.get("limit") || 50);
        return json(await listPlaces(env.DB, limit));
      }

      const placeMatch = pathname.match(/^\/api\/places\/([^/]+)$/);
      if (request.method === "GET" && placeMatch) {
        const placeId = decodeURIComponent(placeMatch[1]);
        if (!(await reviewsFetched(env.DB, placeId))) {
          try {
            const reviewsUrl = commentsUrl(placeId);
            const { status, body, data } = await fetchJson(reviewsUrl);
            const parsed = data as { status?: string; commentaires?: CommentApi[] };
            if (parsed.status === "OK") {
              await ingestReviews(env.DB, placeId, reviewsUrl, status, body, parsed.commentaires ?? []);
              await emit(env.DB, `on-demand reviews for ${placeId}`);
            }
          } catch (err) {
            await emit(
              env.DB,
              `on-demand reviews failed for ${placeId}: ${err instanceof Error ? err.message : err}`,
              "error",
            );
          }
        }
        const row = await getPlaceFull(env.DB, placeId);
        if (!row) return json({ error: "not found" }, 404);
        return json(row);
      }

      if (request.method === "GET" && pathname === "/api/events") {
        return json(await recentEvents(env.DB, Number(url.searchParams.get("limit") || 50)));
      }

      if (request.method === "GET" && pathname === "/api/stream") {
        return sseStream(env);
      }

      if (request.method === "POST" && pathname === "/api/crawl") {
        const batch = Number(env.MAX_PLACES || 10);
        const known = await knownPlacesCount(env.DB);
        await bumpMaxPlaces(env.DB, known + batch);
        const lat = Number(env.DEFAULT_LAT || 41.688908);
        const lng = Number(env.DEFAULT_LNG || 19.641004);
        await reclaimStaleLeases(env.DB);
        await enqueueJob(
          env.DB,
          "filter_cell",
          { lat, lng, mode: "new_only" },
          `filter:${lat.toFixed(5)}:${lng.toFixed(5)}:${known}:${Date.now()}`,
        );
        await emit(env.DB, `crawl +${batch} near point (cap → ${known + batch})`);
        return json({ ok: true, started: true, cap: known + batch, batch });
      }

      if (request.method === "POST" && pathname === "/api/crawl/full") {
        // New archive pass over the grid — does NOT delete any spots.
        const cells = buildEuropeGrid(1);
        const { passId, cells: n } = await startPass(env.DB, "full", cells);
        await reclaimStaleLeases(env.DB);
        await queueNextDiscoveryCells(env.DB, 5);
        await emit(env.DB, `full pass #${passId} started — ${n} cells (append-only archive)`);
        return json({ ok: true, pass_id: passId, cells: n, mode: "full" });
      }

      if (request.method === "POST" && pathname === "/api/crawl/new") {
        const cells = buildEuropeGrid(1);
        const { passId, cells: n } = await startPass(env.DB, "new_only", cells);
        await reclaimStaleLeases(env.DB);
        await queueNextDiscoveryCells(env.DB, 5);
        await emit(env.DB, `fetch-new pass #${passId} started — ${n} cells (unknowns only)`);
        return json({ ok: true, pass_id: passId, cells: n, mode: "new_only" });
      }

      if (request.method === "POST" && pathname === "/api/control/continuous/pause") {
        await setContinuousPaused(env.DB, true);
        await emit(env.DB, "continuous crawl paused — resume will continue this pass");
        return json({ ok: true, continuous_paused: true });
      }

      if (request.method === "POST" && pathname === "/api/control/continuous/resume") {
        await setContinuousPaused(env.DB, false);
        await reclaimStaleLeases(env.DB);
        await queueNextDiscoveryCells(env.DB, 5);
        await emit(env.DB, "continuous crawl resumed");
        return json({ ok: true, continuous_paused: false });
      }

      if (request.method === "POST" && pathname === "/api/tick") {
        const result = await runCrawlLoop(env, { seed: true, maxSteps: 5 });
        return json({ ok: true, ...result });
      }

      if (request.method === "POST" && pathname === "/api/control/pause") {
        await setPaused(env.DB, true);
        await emit(env.DB, "paused via dashboard");
        return json({ ok: true, paused: true });
      }

      if (request.method === "POST" && pathname === "/api/control/resume") {
        await setPaused(env.DB, false);
        await emit(env.DB, "resumed via dashboard");
        return json({ ok: true, paused: false });
      }

      if (request.method === "POST" && pathname.startsWith("/api/control/rescrape/")) {
        const placeId = pathname.split("/").pop()!;
        const jid = await enqueueJob(env.DB, "rescrape_place", { place_id: placeId });
        await emit(env.DB, `enqueued rescrape ${placeId}`, "info", { job_id: jid });
        return json({ ok: true, job_id: jid });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCrawlLoop(env, { seed: true, maxSteps: 20 }));
  },
} satisfies ExportedHandler<Env>;

function sseStream(env: Env): Response {
  let closed = false;
  const owner = `sse-${crypto.randomUUID().slice(0, 8)}`;
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

      let afterSnap = await maxSnapshotId(env.DB);
      let afterEvent = await maxEventId(env.DB);
      await reclaimStaleLeases(env.DB);
      send("hello", { afterSnap, afterEvent });
      send("stats", await getStats(env.DB));

      while (!closed) {
        try {
          await queueNextDiscoveryCells(env.DB, 3);
          const work = await processOneJob(env, owner);
          await maybeCompletePass(env.DB);

          const places = await listPlacesGeoSince(env.DB, afterSnap);
          for (const p of places) {
            afterSnap = Math.max(afterSnap, Number(p.snapshot_id));
            send("place", p);
          }

          const evs = await eventsSince(env.DB, afterEvent, 30);
          for (const e of evs) {
            afterEvent = Math.max(afterEvent, Number((e as { id: number }).id));
            send("log", e);
          }

          if (places.length || evs.length || work === "did_work") {
            send("stats", await getStats(env.DB));
          } else {
            send("ping", { t: Date.now() });
          }

          if (work === "idle" || work === "paused") {
            await new Promise((r) => setTimeout(r, 400));
          }
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

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
