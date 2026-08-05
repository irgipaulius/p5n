import type { Env } from "./types";
import { enqueueJob, getState, placesCount, setPaused } from "./db";

/** Enqueue one nearby filter job — spiral outward from default point. */
export async function seedFilterJob(db: D1Database, env: Env): Promise<string | null> {
  const state = await getState(db);
  if (state.paused) return null;

  const known = await placesCount(db);
  if (known >= state.max_places) return null;

  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')")
    .first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) return null;

  const baseLat = Number(env.DEFAULT_LAT || 41.688908);
  const baseLng = Number(env.DEFAULT_LNG || 19.641004);
  const ring = Math.floor(Math.sqrt(known + 1));
  const angle = (known + 1) * 0.85;
  const lat = baseLat + Math.sin(angle) * ring * 0.06;
  const lng = baseLng + Math.cos(angle) * ring * 0.06;

  const id = `filter:${lat.toFixed(4)}:${lng.toFixed(4)}:${Date.now()}`;
  await enqueueJob(db, "filter_cell", { lat, lng, mode: "new_only" }, id);
  return id;
}

export async function startScrape(env: Env): Promise<{ paused: boolean; job_id: string | null; cap: number }> {
  const db = env.DB;
  const known = await placesCount(db);
  const batch = Number(env.MAX_PLACES || 50);
  const cap = known + batch;

  await db
    .prepare("UPDATE crawler_state SET paused = 0, max_places = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(cap)
    .run();

  const jobId = await seedFilterJob(db, env);
  return { paused: false, job_id: jobId, cap };
}

export async function pauseScrape(env: Env): Promise<{ paused: boolean }> {
  await setPaused(env.DB, true);
  return { paused: true };
}

export async function resumeScrape(env: Env): Promise<{ paused: boolean; job_id: string | null }> {
  await setPaused(env.DB, false);
  const jobId = await seedFilterJob(env.DB, env);
  return { paused: false, job_id: jobId };
}
