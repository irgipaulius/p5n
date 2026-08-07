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
  startWorldGapPass,
  writeDb,
} from "./db";
import { worldGridCellCount } from "./discovery-grid";

const GAP_QUEUE_BATCH = 24;

/** Start or resume the worldwide gap-fill pass. */
export async function startScrape(env: Env): Promise<{
  paused: boolean;
  pass_id: number;
  cells: number;
  resumed: boolean;
  cap_imported?: number;
  frontier?: number;
}> {
  const db = writeDb(env);
  await reclaimStaleLeases(db);

  const state = await getState(db);
  if (state.storage_handbrake) {
    throw new Error("storage handbrake active — DB at 4.5 GB limit; refactor schema before scraping");
  }

  let passId = state.pass_id || 0;
  let cellCount = worldGridCellCount();
  let resumed = false;
  let capImported = 0;
  let frontier = 0;

  if (!passId || state.pass_mode !== "world_gap") {
    const started = await startWorldGapPass(db);
    passId = started.passId;
    capImported = started.capImported;
    frontier = started.frontier;
    await emit(
      db,
      `World gap-fill started — pass #${passId}, ${cellCount} grid slots, ${frontier} frontier, ${capImported} cap-hit imported`,
      "info",
      { pass_id: passId, gap_total: cellCount, frontier, cap_imported: capImported },
    );
  } else {
    resumed = true;
    await setContinuousPaused(db, false);
    await emit(db, `World gap-fill resumed — pass #${passId}`, "info", {
      pass_id: passId,
      gap_progress: state.gap_grid_index ?? 0,
    });
  }

  await setPaused(db, false);
  await queueNextDiscoveryCells(db, GAP_QUEUE_BATCH);

  return {
    paused: false,
    pass_id: passId,
    cells: cellCount,
    resumed,
    cap_imported: capImported,
    frontier,
  };
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
