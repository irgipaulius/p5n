import {
  advancePass,
  claimJob,
  commentsUrl,
  crawlWorkRemaining,
  emit,
  enqueueFilterCellJobs,
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
  reclaimCrawlLease,
  reclaimStaleLeases,
  refreshKnownPlace,
  releaseCrawlLease,
  resolveJob,
  slimPlace,
  tryAcquireCrawlLease,
  writeDb,
} from "./db";
import { markQuerySubdivided, recordQuery, resolveSamplePoints } from "./coverage";
import { FILTER_CAP, MAX_SUBDIVIDE_DEPTH, subdivisionPoints, type SamplePoint } from "./discovery-grid";
import type { CommentApi, Env, JobRow, PlaceApi } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const MAX_REFRESH_PER_FILTER = 25;

function parseSamplePoints(payload: Record<string, unknown>, lat: number, lng: number): SamplePoint[] {
  if (Array.isArray(payload.points)) {
    return payload.points.map((p) => {
      const pt = p as { lat: number; lng: number };
      return { lat: Number(pt.lat), lng: Number(pt.lng) };
    });
  }
  return resolveSamplePoints(lat, lng, {
    useGrid: payload.use_grid === true,
    pinDensity: Number(payload.pin_density ?? 0),
  });
}

async function handleJob(env: Env, job: JobRow, _owner: string) {
  const db = writeDb(env);
  const payload = JSON.parse(job.payload_json) as Record<string, unknown>;

  if (job.kind === "filter_cell") {
    const state = await getState(db);
    if (state.paused) throw new Error("scraper paused");

    const centerLat = Number(payload.lat);
    const centerLng = Number(payload.lng);
    const cellId = payload.cell_id ? String(payload.cell_id) : null;
    const passId = payload.pass_id != null ? Number(payload.pass_id) : null;
    const mode = String(payload.mode || "full");
    const subdivideDepth = Number(payload.subdivide_depth ?? 0);
    const halfDeg = Number(payload.half_deg ?? 0.5);
    const points = parseSamplePoints(payload, centerLat, centerLng);

    let totalWire = 0;
    let totalNew = 0;
    let anyCapHit = false;
    const allKnownSeen: PlaceApi[] = [];

    try {
      for (const pt of points) {
        const url = filterUrl(pt.lat, pt.lng);
        const { status, body, data } = await fetchJson(env, url);
        if (status >= 500) throw new Error(`filter HTTP ${status}`);
        const parsed = data as { status?: string; lieux?: PlaceApi[] };
        if (parsed.status === "ERROR") {
          if (passId != null) {
            await recordQuery(db, passId, pt.lat, pt.lng, 0, 0);
          }
          continue;
        }
        if (parsed.status !== "OK") throw new Error(`filter not OK: ${body.slice(0, 200)}`);

        const places = parsed.lieux ?? [];
        const { newCount, knownSeen, chunks } = await planAndEnqueueFilterIngest(db, places, {
          lat: pt.lat,
          lng: pt.lng,
          cellId,
          passId,
        });

        totalWire += places.length;
        totalNew += newCount;
        if (places.length >= FILTER_CAP) anyCapHit = true;
        allKnownSeen.push(...knownSeen);

        if (passId != null) {
          await recordQuery(db, passId, pt.lat, pt.lng, places.length, newCount);
        }

        const known = await placesCount(db);
        await emit(
          db,
          `filter ${pt.lat},${pt.lng}: wire=${places.length} +${newCount} new (${chunks} chunks, archive=${known}) mode=${mode}`,
          "info",
          { http_status: status, wire_bytes: body.length, new: newCount, chunks, points: points.length },
        );
      }

      if (mode !== "new_only") {
        let queued = 0;
        for (const place of allKnownSeen) {
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

      if (anyCapHit && passId != null && subdivideDepth < MAX_SUBDIVIDE_DEPTH) {
        await markQuerySubdivided(db, centerLat, centerLng);
        const children = subdivisionPoints(centerLat, centerLng, halfDeg);
        await enqueueFilterCellJobs(
          db,
          children.map((c) => ({
            id: `filter:${passId}:sub:${subdivideDepth + 1}:${c.lat.toFixed(4)}:${c.lng.toFixed(4)}`,
            payload: {
              lat: c.lat,
              lng: c.lng,
              cell_id: `sub:${subdivideDepth + 1}:${c.lat.toFixed(4)}:${c.lng.toFixed(4)}`,
              pass_id: passId,
              mode: "new_only",
              subdivide_depth: subdivideDepth + 1,
              half_deg: halfDeg / 2,
            },
          })),
        );
      }

      if (cellId != null && passId != null) {
        await markCellDone(db, passId, cellId, totalWire);
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

    await ingestPlacesChunk(db, places, scrapedAt);
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
  if (await reclaimCrawlLease(db)) await emit(db, "reclaimed expired crawl lease", "info");

  const owner = opts.owner ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
  if (!(await tryAcquireCrawlLease(db, owner, 35))) {
    return { steps: 0, stopped: "no_lease" };
  }
  const maxSteps = opts.maxSteps ?? 200;
  const deadline = opts.maxMs != null ? Date.now() + opts.maxMs : null;
  const state0 = await getState(db);

  try {
    if (opts.seed === true) {
      const known = await placesCount(db);
      const pending = await db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')")
        .first<{ n: number }>();
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

const CRAWL_BURST_MS = 22_000;

function chainRequest(env: Env, ctx: ExecutionContext): void {
  const secret = env.CRAWL_CHAIN_SECRET;
  if (!secret) return;
  const req = new Request("https://crawl.internal/api/internal/crawl-chain", {
    method: "POST",
    headers: { "X-Crawl-Chain": secret },
  });
  const p = env.SELF
    ? env.SELF.fetch(req)
    : fetch(`${(env.TILES_PUBLIC_URL || "https://park5night.hyperreader.eu").replace(/\/$/, "")}/api/internal/crawl-chain`, {
        method: "POST",
        headers: { "X-Crawl-Chain": secret },
      });
  ctx.waitUntil(p.catch(() => undefined));
  void p.catch(() => undefined);
}

export async function scheduleCrawlChain(
  env: Env,
  ctx: ExecutionContext,
  result: { stopped: string },
): Promise<void> {
  if (result.stopped === "paused" || result.stopped === "empty") return;

  const db = writeDb(env);
  if (result.stopped === "no_lease") await reclaimCrawlLease(db);
  if (!(await crawlWorkRemaining(db))) return;

  chainRequest(env, ctx);
}

export function kickCrawlChain(env: Env, ctx: ExecutionContext): void {
  chainRequest(env, ctx);
}

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
  const result = await runCrawlBurst(env, ctx, { owner, quiet: true });
  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { "content-type": "application/json" },
  });
}

export async function runCrawlLoopUntilPaused(env: Env, ctx: ExecutionContext): Promise<void> {
  const owner = `crawl-${crypto.randomUUID().slice(0, 8)}`;
  await emit(writeDb(env), `background crawl started (${owner})`, "info");
  await runCrawlBurst(env, ctx, { owner });
}
