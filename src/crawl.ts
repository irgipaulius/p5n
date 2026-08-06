import {
  advancePass,
  claimJob,
  commentsUrl,
  crawlWorkRemaining,
  emit,
  enqueueJob,
  fetchJson,
  filterUrl,
  getState,
  ingestPlacesChunk,
  ingestReviews,
  markCellDone,
  markCellError,
  placesCount,
  planAndEnqueueFilterIngest,
  queueNextDiscoveryCells,
  reclaimStaleLeases,
  refreshKnownPlace,
  releaseCrawlLease,
  resolveJob,
  slimPlace,
  tryAcquireCrawlLease,
  writeDb,
} from "./db";
import type { CommentApi, Env, JobRow, PlaceApi } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const MAX_REFRESH_PER_FILTER = 25;

async function handleJob(env: Env, job: JobRow, _owner: string) {
  const db = writeDb(env);
  const payload = JSON.parse(job.payload_json) as Record<string, unknown>;

  if (job.kind === "filter_cell") {
    const state = await getState(db);
    if (state.paused) throw new Error("scraper paused");

    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    const cellId = payload.cell_id ? String(payload.cell_id) : null;
    const passId = payload.pass_id != null ? Number(payload.pass_id) : null;
    const mode = String(payload.mode || "full");
    const url = filterUrl(lat, lng);

    try {
      const { status, body, data } = await fetchJson(env, url);
      if (status >= 500) throw new Error(`filter HTTP ${status}`);
      const parsed = data as { status?: string; lieux?: PlaceApi[] };
      if (parsed.status !== "OK") throw new Error(`filter not OK: ${body.slice(0, 200)}`);

      const places = parsed.lieux ?? [];
      const { newCount, knownSeen, chunks } = await planAndEnqueueFilterIngest(db, places, {
        lat,
        lng,
        cellId,
        passId,
      });
      const known = await placesCount(db);
      await emit(
        db,
        `filter ${lat},${lng}: wire=${places.length} +${newCount} new (${chunks} chunks, archive=${known}) mode=${mode}`,
        "info",
        { http_status: status, wire_bytes: body.length, new: newCount, chunks },
      );

      if (mode !== "new_only") {
        let queued = 0;
        for (const place of knownSeen) {
          if (queued >= MAX_REFRESH_PER_FILTER) break;
          const placeId = String(place.id);
          await enqueueJob(
            db,
            "place_refresh",
            { place: slimPlace(place) },
            `refresh:${placeId}`,
            { requeueIfDone: true },
          );
          queued += 1;
        }
      }

      if (cellId != null && passId != null) {
        await markCellDone(db, passId, cellId, places.length);
      }
      await advancePass(db);
    } catch (err) {
      if (cellId != null && passId != null) {
        await markCellError(db, passId, cellId, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
    return;
  }

  if (job.kind === "ingest_chunk") {
    const places = payload.places as PlaceApi[];
    const scrapedAt = String(payload.scraped_at || new Date().toISOString());
    if (!Array.isArray(places) || places.length === 0) throw new Error("ingest_chunk missing places");

    const n = await ingestPlacesChunk(db, places, scrapedAt);
    return;
  }

  if (job.kind === "place_refresh") {
    const place = payload.place as PlaceApi;
    if (!place?.id) throw new Error("place_refresh missing place");
    await refreshKnownPlace(db, place);
    await emit(db, `refreshed place ${place.id}`, "info");
    return;
  }

  if (job.kind === "place_reviews" || job.kind === "rescrape_place") {
    const state = await getState(db);
    if (state.paused) throw new Error("scraper paused");

    const placeId = String(payload.place_id);
    const url = commentsUrl(placeId);
    const { status, body, data } = await fetchJson(env, url);
    if (status >= 500) throw new Error(`commGet HTTP ${status}`);
    const parsed = data as { status?: string; commentaires?: CommentApi[] };
    if (parsed.status !== "OK") throw new Error(`commGet not OK: ${body.slice(0, 200)}`);
    const n = await ingestReviews(db, placeId, url, status, body, parsed.commentaires ?? []);
    await emit(db, `reviews place ${placeId}: ${n} comments`, "info", {
      http_status: status,
      bytes: body.length,
    });
    return;
  }

  throw new Error(`unknown job kind: ${job.kind}`);
}

export async function processOneJob(env: Env, owner: string): Promise<"did_work" | "idle" | "paused"> {
  const db = writeDb(env);
  const state = await getState(db);
  if (state.paused) return "paused";

  const job = await claimJob(db, owner);
  if (!job) return "idle";

  try {
    await handleJob(env, job, owner);
    await resolveJob(db, job, owner);
    await advancePass(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const outcome = await resolveJob(db, job, owner, msg);
    await emit(
      db,
      `job ${job.kind} ${job.id} ${outcome}: ${msg}`,
      outcome === "retry" ? "info" : "error",
      { attempts: job.attempts },
    );
  }
  return "did_work";
}

export async function runCrawlLoop(
  env: Env,
  opts: { maxSteps?: number; seed?: boolean; owner?: string; maxMs?: number; quiet?: boolean } = {},
): Promise<{ steps: number; stopped: string }> {
  const db = writeDb(env);
  const lat = Number(env.DEFAULT_LAT || 41.688908);
  const lng = Number(env.DEFAULT_LNG || 19.641004);

  const reclaimed = await reclaimStaleLeases(db);
  if (reclaimed) await emit(db, `reclaimed ${reclaimed} stale lease(s)`);

  const owner = opts.owner ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
  if (!(await tryAcquireCrawlLease(db, owner, 40))) {
    return { steps: 0, stopped: "no_lease" };
  }
  const maxSteps = opts.maxSteps ?? 200;
  const deadline = opts.maxMs != null ? Date.now() + opts.maxMs : null;
  const state0 = await getState(db);

  try {
  if (opts.seed === true) {
    const known = await placesCount(db);
    const pending = await db.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')",
    ).first<{ n: number }>();
    if (known === 0 && (pending?.n ?? 0) === 0) {
      const jid = `filter:${lat.toFixed(5)}:${lng.toFixed(5)}`;
      await enqueueJob(db, "filter_cell", { lat, lng, mode: "new_only" }, jid);
      await emit(db, `enqueued filter cell ${lat},${lng}`, "info", { job_id: jid });
    }
  }

  await queueNextDiscoveryCells(db, 24);

  if (!opts.quiet) {
    await emit(db, `crawl loop started (${owner})`, "info", { max_places: state0.max_places });
  }

  let steps = 0;
  let idle = 0;

  while (steps < maxSteps && (deadline == null || Date.now() < deadline)) {
    const result = await processOneJob(env, owner);
    if (result === "paused") return { steps, stopped: "paused" };
    if (result === "idle") {
      await queueNextDiscoveryCells(db, 24);
      if (!(await crawlWorkRemaining(db))) {
        await advancePass(db);
        const state = await getState(db);
        if (state.paused && !state.pass_mode) {
          await emit(db, "queue empty — crawl loop stopping");
          return { steps, stopped: "empty" };
        }
        if (!(await crawlWorkRemaining(db))) {
          return { steps, stopped: "empty" };
        }
      }
      idle += 1;
      if (idle >= 8) return { steps, stopped: "idle" };
      await sleep(50);
      continue;
    }
    idle = 0;
    steps += 1;
  }

  if (!opts.quiet && steps > 0) {
    await emit(
      db,
      deadline != null && Date.now() >= deadline
        ? `crawl burst ${steps} jobs (${opts.maxMs}ms)`
        : `crawl loop hit maxSteps=${maxSteps} (${steps} jobs)`,
    );
  }
  return { steps, stopped: deadline != null && Date.now() >= deadline ? "time_budget" : "max_steps" };
  } finally {
    await releaseCrawlLease(db, owner);
  }
}

const CRAWL_BURST_MS = 28_000;

/** Kick another Worker invocation whenever work remains (not just on time budget). */
export async function scheduleCrawlChain(
  env: Env,
  ctx: ExecutionContext,
  result: { stopped: string },
): Promise<void> {
  if (result.stopped === "paused" || result.stopped === "empty") return;

  const db = writeDb(env);
  if (!(await crawlWorkRemaining(db))) return;

  const secret = env.CRAWL_CHAIN_SECRET;
  if (!secret) return;

  const base = (env.TILES_PUBLIC_URL || "https://park5night.hyperreader.eu").replace(/\/$/, "");
  ctx.waitUntil(
    fetch(`${base}/api/internal/crawl-chain`, {
      method: "POST",
      headers: { "X-Crawl-Chain": secret },
    }).catch(() => undefined),
  );
}

/** One burst of jobs, then chain another invocation if work remains. */
export async function runCrawlBurst(
  env: Env,
  ctx: ExecutionContext,
  opts: { seed?: boolean; owner?: string; quiet?: boolean } = {},
): Promise<{ steps: number; stopped: string }> {
  const owner = opts.owner ?? `burst-${crypto.randomUUID().slice(0, 8)}`;
  const result = await runCrawlLoop(env, {
    seed: opts.seed ?? false,
    maxSteps: 500,
    maxMs: CRAWL_BURST_MS,
    owner,
    quiet: opts.quiet ?? false,
  });
  await scheduleCrawlChain(env, ctx, result);
  return result;
}

export async function handleCrawlChainRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.headers.get("X-Crawl-Chain") !== env.CRAWL_CHAIN_SECRET) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const owner = `chain-${Date.now()}`;
  ctx.waitUntil(
    (async () => {
      await runCrawlBurst(env, ctx, { owner });
    })(),
  );
  return new Response(JSON.stringify({ ok: true, started: true }), {
    headers: { "content-type": "application/json" },
  });
}

/** Background driver: burst + self-chain until paused or queue empty. */
export async function runCrawlLoopUntilPaused(env: Env, ctx: ExecutionContext): Promise<void> {
  const owner = `crawl-${crypto.randomUUID().slice(0, 8)}`;
  await emit(writeDb(env), `background crawl started (${owner})`, "info");
  await runCrawlBurst(env, ctx, { owner });
}
