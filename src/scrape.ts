import type { Env } from "./types";
import {
  emit,
  enqueueJob,
  getState,
  placesCount,
  queueNextDiscoveryCells,
  reclaimStaleLeases,
  setContinuousPaused,
  setPaused,
  startPass,
  writeDb,
} from "./db";
import { buildEuropeGrid } from "./placeTypes";

const EUROPE_PASS_CELLS = 3;

/** Start or resume the Europe-wide discovery pass (runs until all cells done). */
export async function startScrape(env: Env): Promise<{
  paused: boolean;
  pass_id: number;
  cells: number;
  resumed: boolean;
}> {
  const db = writeDb(env);
  await reclaimStaleLeases(db);

  const state = await getState(db);
  if (state.storage_handbrake) {
    throw new Error("storage handbrake active — DB at 4.5 GB limit; refactor schema before scraping");
  }

  let passId = state.pass_id || 0;
  let cellCount = 0;
  let resumed = false;

  if (!passId || !state.pass_mode) {
    const cells = buildEuropeGrid(1);
    const started = await startPass(db, "new_only", cells);
    passId = started.passId;
    cellCount = started.cells;
    await emit(db, `Europe scrape started — pass #${passId}, ${cellCount} grid cells`, "info", {
      pass_id: passId,
      cells: cellCount,
    });
  } else {
    resumed = true;
    const prog = await db
      .prepare("SELECT COUNT(*) AS n FROM discovery_cells WHERE pass_id = ?")
      .bind(passId)
      .first<{ n: number }>();
    cellCount = prog?.n ?? 0;
    await setContinuousPaused(db, false);
    await emit(db, `Europe scrape resumed — pass #${passId}`, "info", { pass_id: passId });
  }

  await setPaused(db, false);
  await queueNextDiscoveryCells(db, EUROPE_PASS_CELLS);

  return { paused: false, pass_id: passId, cells: cellCount, resumed };
}

export async function pauseScrape(env: Env): Promise<{ paused: boolean }> {
  await setPaused(env.DB, true);
  return { paused: true };
}

export async function resumeScrape(env: Env): Promise<ReturnType<typeof startScrape>> {
  return startScrape(env);
}

/** @deprecated spiral seed — only used when no pass is active and queue is empty */
export async function seedFilterJob(db: D1Database, env: Env): Promise<string | null> {
  const state = await getState(db);
  if (state.paused || state.storage_handbrake) return null;
  if (state.pass_id && state.pass_mode) {
    await queueNextDiscoveryCells(db, 1);
    return null;
  }

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
