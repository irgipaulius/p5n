import { emit, nowIso, rebuildPinGrid, updateTileManifest, writeDb } from "./db";
import { buildPmtilesBytes, storePmtiles, type BakeProgress } from "./pmtiles-bake";
import type { Env } from "./types";

/** Bakes that never finish (Worker CPU kill) leave status stuck mid-phase. */
const STALE_BAKE_MS = 3 * 60 * 1000;

export interface TileBakeStatus {
  bake_status: string;
  bake_progress: number;
  bake_total: number;
  bake_error: string | null;
  bake_started_at: string | null;
  bake_phase?: string | null;
  version: number;
  place_count: number;
  built_at: string | null;
  bytes: number;
  r2_key: string | null;
  grid_cells: number;
  tile_count: number;
}

export async function getTileBakeStatus(env: Env): Promise<TileBakeStatus | null> {
  return writeDb(env)
    .prepare(
      `SELECT bake_status, bake_progress, bake_total, bake_error, bake_started_at, bake_phase,
              version, place_count, built_at, bytes, r2_key, grid_cells, tile_count
       FROM tile_manifest WHERE id = 1`,
    )
    .first<TileBakeStatus>();
}

export async function startTileBake(_env: Env): Promise<{ ok: boolean; error?: string }> {
  const db = writeDb(_env);
  const row = await db
    .prepare("SELECT bake_status, bake_started_at FROM tile_manifest WHERE id = 1")
    .first<{ bake_status: string; bake_started_at: string | null }>();

  if (row?.bake_status === "running") {
    const started = row.bake_started_at ? Date.parse(row.bake_started_at) : 0;
    const age = started > 0 ? Date.now() - started : STALE_BAKE_MS + 1;
    if (age < STALE_BAKE_MS) {
      return { ok: false, error: "bake already running" };
    }
    await db
      .prepare(
        `UPDATE tile_manifest
         SET bake_status = 'error', bake_error = 'previous bake timed out', bake_phase = NULL
         WHERE id = 1`,
      )
      .run();
    await emit(db, "tile bake: cleared stale running state", "error");
  }

  await db
    .prepare(
      `UPDATE tile_manifest
       SET bake_status = 'running', bake_progress = 0, bake_total = 100,
           bake_error = NULL, bake_started_at = ?, bake_phase = 'grid'
       WHERE id = 1`,
    )
    .bind(nowIso())
    .run();

  return { ok: true };
}

/** Legacy chunk manifest — kept for optional regional metadata. */
export async function listTileChunks(
  env: Env,
  ids: string[],
  request: Request,
): Promise<
  Array<{ chunk_id: string; version: number; place_count: number; bytes: number; url: string; format: string }>
> {
  if (ids.length === 0) return [];
  const db = writeDb(env);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT chunk_id, version, place_count, bytes, r2_key FROM tile_chunks WHERE chunk_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ chunk_id: string; version: number; place_count: number; bytes: number; r2_key: string }>();

  const base = env.TILES_PUBLIC_URL || new URL(request.url).origin;
  return (rows.results ?? []).map((r) => ({
    chunk_id: r.chunk_id,
    version: r.version,
    place_count: r.place_count,
    bytes: r.bytes,
    url: `${base}/api/pins/bbox?west=-180&south=-90&east=180&north=90&limit=1`,
    format: "deprecated",
  }));
}

async function setBakeProgress(db: D1Database, progress: BakeProgress): Promise<void> {
  let pct = 0;
  if (progress.total > 0) {
    pct = Math.min(99, Math.round((progress.done / progress.total) * 100));
  }
  const phaseOffset =
    progress.phase === "grid" ? 0 : progress.phase === "export" ? 15 : progress.phase === "tile" ? 45 : 90;
  const phaseWeight =
    progress.phase === "grid" ? 15 : progress.phase === "export" ? 30 : progress.phase === "tile" ? 45 : 10;
  const overall = Math.min(99, phaseOffset + Math.round((pct / 100) * phaseWeight));

  await db
    .prepare(`UPDATE tile_manifest SET bake_progress = ?, bake_phase = ? WHERE id = 1`)
    .bind(overall, progress.phase)
    .run();
}

/**
 * Dashboard bake: pin_grid fallback + PMTiles MVT heatmap pyramid → R2 (or D1 blob locally).
 */
export async function runTileBake(env: Env): Promise<void> {
  const db = writeDb(env);
  try {
    const total =
      (await db.prepare("SELECT COUNT(*) AS n FROM places WHERE lat IS NOT NULL").first<{ n: number }>())?.n ?? 0;
    await db.prepare("UPDATE tile_manifest SET bake_total = ? WHERE id = 1").bind(Math.max(total, 1)).run();
    await emit(db, `tile bake: building PMTiles heatmap for ${total.toLocaleString()} places…`);

    await setBakeProgress(db, { phase: "grid", done: 0, total: 1 });
    const gridCells = await rebuildPinGrid(db);
    await setBakeProgress(db, { phase: "grid", done: 1, total: 1 });

    if (gridCells === 0) {
      throw new Error("no places with coordinates to bake");
    }

    const { bytes, placeCount, tileCount } = await buildPmtilesBytes(db, (p) => setBakeProgress(db, p));

    const version = Date.now();
    const r2Key = `pins-v${version}.pmtiles`;

    await setBakeProgress(db, { phase: "upload", done: 0, total: 1 });
    await emit(db, `tile bake: uploading ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB PMTiles (${tileCount} tiles)…`);
    await storePmtiles(env, db, r2Key, bytes);
    await setBakeProgress(db, { phase: "upload", done: 1, total: 1 });

    await updateTileManifest(db, version, placeCount, r2Key, bytes.byteLength, gridCells, tileCount);
    await db
      .prepare(
        `UPDATE tile_manifest SET bake_status = 'idle', bake_progress = 100, bake_phase = NULL, bake_error = NULL WHERE id = 1`,
      )
      .run();

    const store = env.TILES ? "R2" : "D1";
    await emit(
      db,
      `tile bake done — ${placeCount.toLocaleString()} pins → PMTiles (${tileCount} tiles, ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB on ${store}). Map uses MVT heatmap.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .prepare(`UPDATE tile_manifest SET bake_status = 'error', bake_error = ?, bake_phase = NULL WHERE id = 1`)
      .bind(msg)
      .run();
    await emit(db, `tile bake failed: ${msg}`, "error");
  }
}

export async function readTileBlob(env: Env, key: string): Promise<{ data: ArrayBuffer; bytes: number } | null> {
  const { readStoredPmtiles } = await import("./pmtiles-bake");
  const db = writeDb(env);
  const data = await readStoredPmtiles(env, db, key);
  if (!data) return null;
  return { data, bytes: data.byteLength };
}
