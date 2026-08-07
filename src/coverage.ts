import {
  CELL_RADIUS_KM,
  FILTER_CAP,
  MERGE_RADIUS_KM,
  PIN_GRID_DENSITY_THRESHOLD,
  haversineKm,
  samplePointsForCell,
  type SamplePoint,
} from "./discovery-grid";
import { encodeGeohash, geohashPrefixes } from "./geohash";

function nowIso(): string {
  return new Date().toISOString();
}

const NEIGHBOR_OFFSETS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Bbox prefilter for merge-radius (~12 km ≈ 0.11°). */
function queryBbox(lat: number, lng: number): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const d = MERGE_RADIUS_KM / 111 + 0.02;
  const dLng = MERGE_RADIUS_KM / (111 * Math.cos((lat * Math.PI) / 180)) + 0.02;
  return { minLat: lat - d, maxLat: lat + d, minLng: lng - dLng, maxLng: lng + dLng };
}

export async function shouldSkipQuery(db: D1Database, lat: number, lng: number): Promise<boolean> {
  const box = queryBbox(lat, lng);
  const res = await db
    .prepare(
      `SELECT lat, lng, cap_hit, subdivided FROM discovery_queries
       WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
    )
    .bind(box.minLat, box.maxLat, box.minLng, box.maxLng)
    .all<{ lat: number; lng: number; cap_hit: number; subdivided: number }>();

  for (const row of res.results ?? []) {
    if (haversineKm(lat, lng, row.lat, row.lng) > MERGE_RADIUS_KM) continue;
    if (row.cap_hit === 0) return true;
    if (row.cap_hit === 1 && row.subdivided === 1) return true;
  }
  return false;
}

export async function recordQuery(
  db: D1Database,
  passId: number,
  lat: number,
  lng: number,
  wireCount: number,
  newCount: number,
  opts: { subdivided?: boolean } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO discovery_queries (pass_id, lat, lng, wire_count, new_count, cap_hit, subdivided, queried_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      passId,
      lat,
      lng,
      wireCount,
      newCount,
      wireCount >= FILTER_CAP ? 1 : 0,
      opts.subdivided ? 1 : 0,
      nowIso(),
    )
    .run();
}

export async function markQuerySubdivided(db: D1Database, lat: number, lng: number): Promise<void> {
  const box = queryBbox(lat, lng);
  await db
    .prepare(
      `UPDATE discovery_queries SET subdivided = 1
       WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
         AND cap_hit = 1`,
    )
    .bind(box.minLat, box.maxLat, box.minLng, box.maxLng)
    .run();
}

export async function pinGridDensity(db: D1Database, lat: number, lng: number): Promise<number> {
  const { g4 } = geohashPrefixes(lat, lng);
  const row = await db.prepare("SELECT count FROM pin_grid WHERE g4 = ?").bind(g4).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function queryStats(db: D1Database, passId?: number): Promise<{
  queries_run: number;
  queries_new_pins: number;
  cap_hits: number;
}> {
  const row = passId
    ? await db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(new_count), 0) AS new_pins,
                  COALESCE(SUM(cap_hit), 0) AS caps
           FROM discovery_queries WHERE pass_id = ?`,
        )
        .bind(passId)
        .first<{ n: number; new_pins: number; caps: number }>()
    : await db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(new_count), 0) AS new_pins,
                  COALESCE(SUM(cap_hit), 0) AS caps
           FROM discovery_queries`,
        )
        .first<{ n: number; new_pins: number; caps: number }>();
  return {
    queries_run: row?.n ?? 0,
    queries_new_pins: row?.new_pins ?? 0,
    cap_hits: row?.caps ?? 0,
  };
}

/** Import cap-hit cells from a prior pass as coverage signals + pending subdivisions. */
export async function importCapHitFromPass(db: D1Database, oldPassId: number, newPassId: number): Promise<number> {
  const cells = await db
    .prepare(
      `SELECT id, lat, lng, places_found FROM discovery_cells
       WHERE pass_id = ? AND status = 'done' AND places_found >= ?`,
    )
    .bind(oldPassId, FILTER_CAP)
    .all<{ id: string; lat: number; lng: number; places_found: number }>();

  const rows = cells.results ?? [];
  if (rows.length === 0) return 0;

  const t = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const c of rows) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO discovery_queries (pass_id, lat, lng, wire_count, new_count, cap_hit, subdivided, queried_at)
           VALUES (?, ?, ?, ?, 0, 1, 0, ?)`,
        )
        .bind(newPassId, c.lat, c.lng, c.places_found, t),
    );
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO discovery_cells (id, pass_id, lat, lng, status, places_found, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
        )
        .bind(`cap:${c.id}`, newPassId, c.lat, c.lng, t),
    );
  }
  for (let i = 0; i < stmts.length; i += 40) {
    await db.batch(stmts.slice(i, i + 40));
  }
  return rows.length;
}

/** Empty geohash4 cells adjacent to populated pin_grid cells. */
export async function findFrontierCells(db: D1Database, limit = 500): Promise<SamplePoint[]> {
  const populated = await db
    .prepare(`SELECT g4, lat, lng, count FROM pin_grid WHERE count > 0 ORDER BY count DESC LIMIT 2000`)
    .all<{ g4: string; lat: number; lng: number; count: number }>();

  const have = new Set((populated.results ?? []).map((r) => r.g4));
  const frontier = new Map<string, SamplePoint>();

  for (const cell of populated.results ?? []) {
    const stepLat = 0.12;
    const stepLng = 0.12 / Math.max(0.3, Math.cos((cell.lat * Math.PI) / 180));
    for (const [dLat, dLng] of NEIGHBOR_OFFSETS) {
      const nLat = cell.lat + dLat * stepLat;
      const nLng = cell.lng + dLng * stepLng;
      const g4 = encodeGeohash(nLat, nLng, 4);
      if (have.has(g4) || frontier.has(g4)) continue;
      frontier.set(g4, { lat: nLat, lng: nLng });
      if (frontier.size >= limit) return [...frontier.values()];
    }
  }
  return [...frontier.values()];
}

export async function seedFrontierDiscoveryCells(db: D1Database, passId: number, limit = 500): Promise<number> {
  const points = await findFrontierCells(db, limit);
  if (points.length === 0) return 0;
  const t = nowIso();
  const stmts = points.map((p, i) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO discovery_cells (id, pass_id, lat, lng, status, places_found, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .bind(`frontier:${i}:${p.lat.toFixed(3)}:${p.lng.toFixed(3)}`, passId, p.lat, p.lng, t),
  );
  for (let i = 0; i < stmts.length; i += 40) {
    await db.batch(stmts.slice(i, i + 40));
  }
  return points.length;
}

export function resolveSamplePoints(
  lat: number,
  lng: number,
  opts: { useGrid?: boolean; pinDensity?: number },
): SamplePoint[] {
  if (opts.useGrid || (opts.pinDensity ?? 0) >= PIN_GRID_DENSITY_THRESHOLD) {
    return samplePointsForCell(lat, lng, CELL_RADIUS_KM);
  }
  return [{ lat, lng }];
}
