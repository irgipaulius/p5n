import {
  claimJob,
  commentsUrl,
  emit,
  enqueueJob,
  fetchJson,
  filterUrl,
  getState,
  ingestNewPlacesFromFilter,
  ingestReviews,
  markCellDone,
  markCellError,
  placesCount,
  reclaimStaleLeases,
  refreshKnownPlace,
  resolveJob,
  slimPlace,
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
      const { newCount, knownSeen } = await ingestNewPlacesFromFilter(db, places, body.length);
      const known = await placesCount(db);
      await emit(
        db,
        `filter ${lat},${lng}: wire=${places.length} +${newCount} new (archive=${known}) mode=${mode}`,
        "info",
        { http_status: status, wire_bytes: body.length, new: newCount },
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
    } catch (err) {
      if (cellId != null && passId != null) {
        await markCellError(db, passId, cellId, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
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
  opts: { maxSteps?: number; seed?: boolean } = {},
): Promise<{ steps: number; stopped: string }> {
  const db = writeDb(env);
  const lat = Number(env.DEFAULT_LAT || 41.688908);
  const lng = Number(env.DEFAULT_LNG || 19.641004);

  const reclaimed = await reclaimStaleLeases(db);
  if (reclaimed) await emit(db, `reclaimed ${reclaimed} stale lease(s)`);

  const owner = `worker-${crypto.randomUUID().slice(0, 8)}`;
  const maxSteps = opts.maxSteps ?? 200;
  const state0 = await getState(db);

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

  await emit(db, `crawl loop started (${owner})`, "info", { max_places: state0.max_places });

  let steps = 0;
  let idle = 0;

  while (steps < maxSteps) {
    const result = await processOneJob(env, owner);
    if (result === "paused") return { steps, stopped: "paused" };
    if (result === "idle") {
      idle += 1;
      const pending = await db.prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'",
      ).first<{ n: number }>();
      if ((pending?.n ?? 0) === 0) {
        await emit(db, "queue empty — crawl loop stopping");
        return { steps, stopped: "empty" };
      }
      if (idle >= 5) return { steps, stopped: "idle" };
      await sleep(200);
      continue;
    }
    idle = 0;
    steps += 1;
  }

  await emit(db, `crawl loop hit maxSteps=${maxSteps}`);
  return { steps, stopped: "max_steps" };
}
