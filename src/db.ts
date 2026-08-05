import { encodeAttributes, typeCode } from "./attributes";
import { readDb, writeDb } from "./db-session";
import { geohashPrefixes } from "./geohash";
import type {
  AttributeDef,
  CommentApi,
  CrawlerState,
  EnrichPin,
  Env,
  JobKind,
  JobRow,
  PinGeo,
  PlaceApi,
  PlaceRow,
  SearchPin,
} from "./types";

const GUEST = "https://guest.park4night.com/services/V4.1";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function emit(
  db: D1Database,
  message: string,
  level = "info",
  meta?: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO run_events (created_at, level, message, meta_json) VALUES (?, ?, ?, ?)",
    )
    .bind(nowIso(), level, message, meta ? JSON.stringify(meta) : null)
    .run();
}

export async function getState(db: D1Database): Promise<CrawlerState> {
  const row = await db.prepare("SELECT * FROM crawler_state WHERE id = 1").first<CrawlerState>();
  if (!row) throw new Error("crawler_state missing — run migrations");
  return row;
}

export async function setPaused(db: D1Database, paused: boolean): Promise<void> {
  await db
    .prepare("UPDATE crawler_state SET paused = ?, updated_at = ? WHERE id = 1")
    .bind(paused ? 1 : 0, nowIso())
    .run();
}

export async function setMaxPlaces(db: D1Database, maxPlaces: number): Promise<void> {
  await db
    .prepare("UPDATE crawler_state SET max_places = ?, updated_at = ? WHERE id = 1")
    .bind(maxPlaces, nowIso())
    .run();
}

export async function bumpMaxPlaces(db: D1Database, newCap: number): Promise<void> {
  await setMaxPlaces(db, newCap);
}

export async function placesCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM places").first<{ n: number }>();
  return row?.n ?? 0;
}

/** @deprecated alias */
export const knownPlacesCount = placesCount;

export async function reclaimStaleLeases(db: D1Database): Promise<number> {
  const now = Date.now() / 1000;
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .bind(nowIso(), now)
    .run();
  return res.meta.changes ?? 0;
}

export async function enqueueJob(
  db: D1Database,
  kind: JobKind,
  payload: Record<string, unknown>,
  jobId?: string,
  opts: { requeueIfDone?: boolean } = {},
): Promise<string> {
  const id = jobId ?? crypto.randomUUID();
  const existing = await db
    .prepare("SELECT id, status FROM jobs WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  const t = nowIso();
  if (existing) {
    if (opts.requeueIfDone && (existing.status === "done" || existing.status === "error")) {
      await db
        .prepare(
          `UPDATE jobs SET status = 'pending', payload_json = ?, attempts = 0, last_error = NULL,
           lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
        )
        .bind(JSON.stringify(payload), t, id)
        .run();
    }
    return id;
  }
  await db
    .prepare(
      `INSERT INTO jobs (id, kind, payload_json, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .bind(id, kind, JSON.stringify(payload), t, t)
    .run();
  return id;
}

export async function claimJob(db: D1Database, owner: string, leaseSeconds = 120): Promise<JobRow | null> {
  const state = await getState(db);
  if (state.paused) return null;

  const now = Date.now() / 1000;
  const row = await db
    .prepare(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY CASE kind
         WHEN 'filter_cell' THEN 1
         WHEN 'rescrape_place' THEN 2
         WHEN 'place_refresh' THEN 3
         WHEN 'place_reviews' THEN 4
         ELSE 9
       END, created_at ASC
       LIMIT 1`,
    )
    .bind(now)
    .first<JobRow>();
  if (!row) return null;

  const until = now + leaseSeconds;
  await db
    .prepare(
      `UPDATE jobs SET status = 'running', lease_owner = ?, lease_until = ?,
       attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`,
    )
    .bind(owner, until, nowIso(), row.id)
    .run();

  return (
    (await db
      .prepare("SELECT * FROM jobs WHERE id = ? AND lease_owner = ? AND status = 'running'")
      .bind(row.id, owner)
      .first<JobRow>()) ?? null
  );
}

const MAX_ATTEMPTS = 5;

export async function resolveJob(
  db: D1Database,
  job: JobRow,
  owner: string,
  error?: string,
): Promise<"done" | "retry" | "error"> {
  if (!error) {
    await db
      .prepare(
        `UPDATE jobs SET status = 'done', last_error = NULL, lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE id = ? AND lease_owner = ?`,
      )
      .bind(nowIso(), job.id, owner)
      .run();
    return "done";
  }

  if (job.attempts < MAX_ATTEMPTS) {
    const backoff = Math.min(300, 2 ** job.attempts);
    const until = Date.now() / 1000 + backoff;
    await db
      .prepare(
        `UPDATE jobs SET status = 'pending', last_error = ?, lease_owner = NULL, lease_until = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ?`,
      )
      .bind(error, until, nowIso(), job.id, owner)
      .run();
    return "retry";
  }

  await db
    .prepare(
      `UPDATE jobs SET status = 'error', last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ?`,
    )
    .bind(error, nowIso(), job.id, owner)
    .run();
  return "error";
}

export function pickDescription(place: PlaceApi): string {
  return (
    [
      place.description_en,
      place.description_fr,
      place.description_de,
      place.description_it,
      place.description_es,
      place.description_nl,
    ]
      .map((d) => String(d || "").trim())
      .find(Boolean) || ""
  );
}

export function slimPlace(place: PlaceApi): Record<string, unknown> {
  const desc = pickDescription(place);
  const { attrs0, attrs1 } = encodeAttributes(place);
  return {
    id: place.id,
    latitude: place.latitude,
    longitude: place.longitude,
    name: place.name,
    titre: place.titre,
    code: place.code,
    pays: place.pays,
    ville: place.ville,
    note_moyenne: place.note_moyenne,
    nb_commentaires: place.nb_commentaires,
    description: desc,
    attrs0,
    attrs1,
    wifi: place.wifi,
    douche: place.douche,
    electricite: place.electricite,
    animaux: place.animaux,
  };
}

function placeFromApi(place: PlaceApi): {
  placeId: string;
  lat: number;
  lng: number;
  name: string;
  type: string;
  rating: number | null;
  reviewCount: number;
  city: string | null;
  country: string | null;
  attrs0: number;
  attrs1: number;
  description: string;
  geohash4: string;
  geohash6: string;
} {
  const lat = Number(place.latitude);
  const lng = Number(place.longitude);
  const { g4, g6 } = geohashPrefixes(lat, lng);
  const { attrs0, attrs1 } = encodeAttributes(place);
  return {
    placeId: String(place.id),
    lat,
    lng,
    name: String(place.name || "").trim() || String(place.titre || "").trim(),
    type: typeCode(place.code),
    rating: place.note_moyenne ? Number(place.note_moyenne) : null,
    reviewCount: place.nb_commentaires ? Number(place.nb_commentaires) : 0,
    city: place.ville ? String(place.ville) : null,
    country: place.pays ? String(place.pays) : null,
    attrs0,
    attrs1,
    description: pickDescription(place),
    geohash4: g4,
    geohash6: g6,
  };
}

async function upsertPlaceBatch(db: D1Database, place: PlaceApi, scrapedAt: string): Promise<boolean> {
  const p = placeFromApi(place);
  const existing = await db
    .prepare("SELECT place_id FROM places WHERE place_id = ?")
    .bind(p.placeId)
    .first();

  const detailJson = JSON.stringify(slimPlace(place));
  const snapshotJson = JSON.stringify({ ...slimPlace(place), raw_keys: Object.keys(place) });

  const stmts = [
    db
      .prepare(
        `INSERT INTO places (
          place_id, source, lat, lng, geohash4, geohash6, type, rating, review_count,
          attrs0, attrs1, name, city, country, updated_at, reviews_fetched
        ) VALUES (?, 'p4n', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(place_id) DO UPDATE SET
          lat = excluded.lat, lng = excluded.lng,
          geohash4 = excluded.geohash4, geohash6 = excluded.geohash6,
          type = excluded.type, rating = excluded.rating, review_count = excluded.review_count,
          attrs0 = excluded.attrs0, attrs1 = excluded.attrs1,
          name = excluded.name, city = excluded.city, country = excluded.country,
          updated_at = excluded.updated_at`,
      )
      .bind(
        p.placeId,
        p.lat,
        p.lng,
        p.geohash4,
        p.geohash6,
        p.type,
        p.rating,
        p.reviewCount,
        p.attrs0,
        p.attrs1,
        p.name,
        p.city,
        p.country,
        scrapedAt,
      ),
    db
      .prepare(
        `INSERT INTO place_details (place_id, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(place_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      )
      .bind(p.placeId, detailJson, scrapedAt),
    db
      .prepare("INSERT INTO snapshots (place_id, scraped_at, payload_json) VALUES (?, ?, ?)")
      .bind(p.placeId, scrapedAt, snapshotJson),
    db
      .prepare("INSERT INTO places_fts (place_id, name, city, description) VALUES (?, ?, ?, ?)")
      .bind(p.placeId, p.name, p.city ?? "", p.description),
  ];

  // FTS5 doesn't support ON CONFLICT on virtual tables cleanly — delete+insert for updates
  if (existing) {
    stmts[3] = db.prepare("DELETE FROM places_fts WHERE place_id = ?").bind(p.placeId);
    await db.batch([
      stmts[0],
      stmts[1],
      stmts[2],
      db.prepare("DELETE FROM places_fts WHERE place_id = ?").bind(p.placeId),
      db
        .prepare("INSERT INTO places_fts (place_id, name, city, description) VALUES (?, ?, ?, ?)")
        .bind(p.placeId, p.name, p.city ?? "", p.description),
    ]);
  } else {
    await db.batch(stmts);
  }

  return !existing;
}

export async function ingestNewPlacesFromFilter(
  db: D1Database,
  places: PlaceApi[],
  wireBytes: number,
): Promise<{ newCount: number; newIds: string[]; knownSeen: PlaceApi[] }> {
  const state = await getState(db);
  const cap = state.max_places;
  const scrapedAt = nowIso();
  let known = await placesCount(db);
  let slots = Math.max(0, cap - known);

  const fresh: PlaceApi[] = [];
  const knownSeen: PlaceApi[] = [];

  for (const place of places) {
    const placeId = String(place.id);
    const existing = await db.prepare("SELECT place_id FROM places WHERE place_id = ?").bind(placeId).first();
    if (existing) {
      knownSeen.push(place);
      continue;
    }
    if (slots <= 0) continue;
    fresh.push(place);
    slots -= 1;
  }

  for (const place of fresh) {
    await upsertPlaceBatch(db, place, scrapedAt);
  }

  const count = await placesCount(db);
  await db
    .prepare("UPDATE crawler_state SET places_crawled = ?, updated_at = ? WHERE id = 1")
    .bind(count, scrapedAt)
    .run();

  await emit(db, `filter ingest: +${fresh.length} new (wire=${wireBytes}B, archive=${count})`, "info", {
    wire_bytes: wireBytes,
    new: fresh.length,
    known_seen: knownSeen.length,
  });

  return {
    newCount: fresh.length,
    newIds: fresh.map((p) => String(p.id)),
    knownSeen,
  };
}

export async function refreshKnownPlace(db: D1Database, place: PlaceApi): Promise<void> {
  const placeId = String(place.id);
  const known = await db.prepare("SELECT place_id FROM places WHERE place_id = ?").bind(placeId).first();
  if (!known) return;
  await upsertPlaceBatch(db, place, nowIso());
}

export async function ingestReviews(
  db: D1Database,
  placeId: string,
  _url: string,
  _status: number,
  _body: string,
  comments: CommentApi[],
): Promise<number> {
  const scrapedAt = nowIso();
  const stmts: D1PreparedStatement[] = [];

  for (const c of comments) {
    const reviewId = String(c.id);
    const comment = String(c.commentaire || "");
    const payload = JSON.stringify({
      id: c.id,
      note: c.note,
      commentaire: c.commentaire,
      uuid: c.uuid,
      date_creation: c.date_creation,
      type_vehicule: c.type_vehicule,
    });
    stmts.push(
      db
        .prepare(
          `INSERT INTO reviews (review_id, place_id, rating, author, created_at, comment, payload_json, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(review_id, place_id) DO UPDATE SET
             rating = excluded.rating, author = excluded.author, created_at = excluded.created_at,
             comment = excluded.comment, payload_json = excluded.payload_json, scraped_at = excluded.scraped_at`,
        )
        .bind(
          reviewId,
          placeId,
          c.note ? Number(c.note) : null,
          c.uuid ?? null,
          c.date_creation ?? null,
          comment,
          payload,
          scrapedAt,
        ),
    );
    stmts.push(db.prepare("DELETE FROM reviews_fts WHERE review_id = ? AND place_id = ?").bind(reviewId, placeId));
    stmts.push(
      db.prepare("INSERT INTO reviews_fts (place_id, review_id, comment) VALUES (?, ?, ?)").bind(placeId, reviewId, comment),
    );
  }

  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50));
  }

  await db
    .prepare("UPDATE places SET reviews_fetched = 1, updated_at = ? WHERE place_id = ?")
    .bind(scrapedAt, placeId)
    .run();

  return comments.length;
}

export async function reviewsFetched(db: D1Database, placeId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT reviews_fetched FROM places WHERE place_id = ?")
    .bind(placeId)
    .first<{ reviews_fetched: number }>();
  return !!row?.reviews_fetched;
}

export async function getStats(db: D1Database) {
  const state = await getState(db);
  const jobs = await db
    .prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
    .all<{ status: string; n: number }>();
  const known = await placesCount(db);
  const reviewCount =
    (await db.prepare("SELECT COUNT(*) AS n FROM reviews").first<{ n: number }>())?.n ?? 0;
  const snapshotCount =
    (await db.prepare("SELECT COUNT(*) AS n FROM snapshots").first<{ n: number }>())?.n ?? 0;
  const tileManifest = await db.prepare("SELECT * FROM tile_manifest WHERE id = 1").first();

  const jobMap: Record<string, number> = {};
  for (const j of jobs.results ?? []) jobMap[j.status] = j.n;

  const pass = await passProgress(db).catch(() => ({
    pass_id: 0,
    mode: "",
    continuous_paused: true,
    pending: 0,
    done: 0,
    error: 0,
    total: 0,
  }));

  return {
    state,
    jobs: jobMap,
    places: known,
    reviews: reviewCount,
    snapshots: snapshotCount,
    tile_manifest: tileManifest,
    pass,
  };
}

export async function listPlaces(db: D1Database, limit = 50) {
  const res = await db
    .prepare(
      `SELECT place_id, name, lat, lng, country, city, rating, review_count, type, updated_at, reviews_fetched
       FROM places ORDER BY CAST(place_id AS INTEGER) LIMIT ?`,
    )
    .bind(limit)
    .all();
  return res.results ?? [];
}

import { typeToInt } from "./attributes";

function rowToPin(row: PlaceRow): PinGeo {
  return {
    id: row.place_id,
    lat: row.lat,
    lng: row.lng,
    t: typeToInt(row.type),
    type: row.type,
    name: row.name,
    updated_at: row.updated_at,
  };
}

export async function listPlacesGeo(env: Env): Promise<PinGeo[]> {
  const res = await readDb(env)
    .prepare(
      `SELECT place_id, lat, lng, type, name, updated_at FROM places
       WHERE lat IS NOT NULL AND lng IS NOT NULL`,
    )
    .all<PlaceRow>();
  return (res.results ?? []).map(rowToPin);
}

export async function listPlacesGeoSince(env: Env, sinceIso: string): Promise<PinGeo[]> {
  const res = await readDb(env)
    .prepare(
      `SELECT place_id, lat, lng, type, name, updated_at FROM places
       WHERE updated_at > ? AND lat IS NOT NULL AND lng IS NOT NULL
       ORDER BY updated_at ASC LIMIT 200`,
    )
    .bind(sinceIso)
    .all<PlaceRow>();
  return (res.results ?? []).map(rowToPin);
}

export async function listPlacesInBbox(
  env: Env,
  west: number,
  south: number,
  east: number,
  north: number,
  limit = 5000,
): Promise<PinGeo[]> {
  const res = await readDb(env)
    .prepare(
      `SELECT place_id, lat, lng, type, name, updated_at FROM places
       WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
       ORDER BY rating DESC NULLS LAST
       LIMIT ?`,
    )
    .bind(south, north, west, east, limit)
    .all<PlaceRow>();
  return (res.results ?? []).map(rowToPin);
}

export async function enrichPlaces(
  env: Env,
  west: number,
  south: number,
  east: number,
  north: number,
  since?: string,
): Promise<EnrichPin[]> {
  let sql = `SELECT place_id, lat, lng, type, rating, review_count, attrs0, attrs1, name
             FROM places
             WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`;
  const binds: (string | number)[] = [south, north, west, east];
  if (since) {
    sql += " AND updated_at > ?";
    binds.push(since);
  }
  sql += " ORDER BY updated_at DESC LIMIT 2000";
  const res = await readDb(env).prepare(sql).bind(...binds).all<PlaceRow>();
  return (res.results ?? []).map((r) => ({
    id: r.place_id,
    lat: r.lat,
    lng: r.lng,
    t: typeToInt(r.type),
    type: r.type,
    rating: r.rating,
    reviews: r.review_count,
    attrs0: r.attrs0,
    attrs1: r.attrs1,
    name: r.name,
  }));
}

export async function listAttributeDefs(env: Env): Promise<AttributeDef[]> {
  const res = await readDb(env)
    .prepare("SELECT bit_index, column_name, key, label FROM attribute_defs ORDER BY bit_index")
    .all<AttributeDef>();
  return res.results ?? [];
}

export async function searchPlacesPage(
  env: Env,
  opts: {
    q?: string;
    attrs0?: number;
    attrs1?: number;
    type?: string;
    offset: number;
    limit: number;
  },
): Promise<SearchPin[]> {
  const { q, attrs0, attrs1, type, offset, limit } = opts;
  const binds: (string | number)[] = [];
  let sql: string;

  if (q && q.trim()) {
    const term = q.trim().replace(/"/g, '""');
    sql = `SELECT p.place_id, p.lat, p.lng, p.type, p.name, p.rating, p.review_count,
                  bm25(places_fts) AS score
           FROM places_fts
           JOIN places p ON p.place_id = places_fts.place_id
           WHERE places_fts MATCH ?`;
    binds.push(`"${term}"* OR ${term}*`);
    if (type) {
      sql += " AND p.type = ?";
      binds.push(type);
    }
    if (attrs0 != null && attrs0 !== 0) {
      sql += " AND (p.attrs0 & ?) = ?";
      binds.push(attrs0, attrs0);
    }
    if (attrs1 != null && attrs1 !== 0) {
      sql += " AND (p.attrs1 & ?) = ?";
      binds.push(attrs1, attrs1);
    }
    sql += " ORDER BY score ASC, p.rating DESC NULLS LAST LIMIT ? OFFSET ?";
  } else {
    sql = `SELECT place_id, lat, lng, type, name, rating, review_count, 0 AS score FROM places WHERE 1=1`;
    if (type) {
      sql += " AND type = ?";
      binds.push(type);
    }
    if (attrs0 != null && attrs0 !== 0) {
      sql += " AND (attrs0 & ?) = ?";
      binds.push(attrs0, attrs0);
    }
    if (attrs1 != null && attrs1 !== 0) {
      sql += " AND (attrs1 & ?) = ?";
      binds.push(attrs1, attrs1);
    }
    sql += " ORDER BY rating DESC NULLS LAST LIMIT ? OFFSET ?";
  }
  binds.push(limit, offset);

  const res = await readDb(env).prepare(sql).bind(...binds).all<PlaceRow & { score: number }>();
  return (res.results ?? []).map((r) => ({
    id: r.place_id,
    lat: r.lat,
    lng: r.lng,
    t: typeToInt(r.type),
    type: r.type,
    name: r.name,
    rating: r.rating,
    reviews: r.review_count,
    score: r.score,
  }));
}

export async function maxEventId(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM run_events").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function eventsSince(db: D1Database, afterId: number, limit = 50) {
  const res = await db
    .prepare("SELECT * FROM run_events WHERE id > ? ORDER BY id ASC LIMIT ?")
    .bind(afterId, limit)
    .all();
  return res.results ?? [];
}

export async function getPlaceFull(env: Env, placeId: string) {
  const row = await readDb(env)
    .prepare(
      `SELECT p.*, d.payload_json AS detail_json
       FROM places p
       LEFT JOIN place_details d ON d.place_id = p.place_id
       WHERE p.place_id = ?`,
    )
    .bind(placeId)
    .first<PlaceRow & { detail_json: string | null }>();
  if (!row) return null;

  const reviews = await readDb(env)
    .prepare(
      `SELECT review_id, place_id, rating, author, created_at, comment, payload_json, scraped_at
       FROM reviews WHERE place_id = ? ORDER BY created_at DESC LIMIT 200`,
    )
    .bind(placeId)
    .all();

  let detail: unknown = null;
  if (row.detail_json) {
    try {
      detail = JSON.parse(row.detail_json);
    } catch {
      detail = row.detail_json;
    }
  }

  return {
    ...row,
    detail,
    reviews: (reviews.results ?? []).map((r) => {
      const rr = { ...r } as Record<string, unknown>;
      try {
        rr.payload_json = JSON.parse(String(r.payload_json));
      } catch {
        /* keep */
      }
      return rr;
    }),
  };
}

export async function recentEvents(db: D1Database, limit = 40) {
  const res = await db
    .prepare("SELECT * FROM run_events ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all();
  return res.results ?? [];
}

export async function setContinuousPaused(db: D1Database, paused: boolean): Promise<void> {
  await db
    .prepare("UPDATE crawler_state SET continuous_paused = ?, updated_at = ? WHERE id = 1")
    .bind(paused ? 1 : 0, nowIso())
    .run();
}

export async function startPass(
  db: D1Database,
  mode: "full" | "new_only",
  cells: { id: string; lat: number; lng: number }[],
): Promise<{ passId: number; cells: number }> {
  const state = await getState(db);
  const passId = (state.pass_id || 0) + 1;
  const t = nowIso();

  await db
    .prepare(
      `UPDATE crawler_state SET pass_id = ?, pass_mode = ?, continuous_paused = 0,
       max_places = ?, updated_at = ? WHERE id = 1`,
    )
    .bind(passId, mode, 50_000_000, t)
    .run();

  const stmts = cells.map((c) =>
    db
      .prepare(
        `INSERT INTO discovery_cells (id, pass_id, lat, lng, status, places_found, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .bind(c.id, passId, c.lat, c.lng, t),
  );
  for (let i = 0; i < stmts.length; i += 200) {
    await db.batch(stmts.slice(i, i + 200));
  }

  return { passId, cells: cells.length };
}

export async function queueNextDiscoveryCells(db: D1Database, limit = 3): Promise<number> {
  const state = await getState(db);
  if (state.continuous_paused) return 0;
  const passId = state.pass_id || 0;
  if (!passId || !state.pass_mode) return 0;

  const pendingJobs = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND kind = 'filter_cell'`)
    .first<{ n: number }>();
  if ((pendingJobs?.n ?? 0) >= limit) return 0;

  const need = limit - (pendingJobs?.n ?? 0);
  const cells = await db
    .prepare(
      `SELECT id, lat, lng FROM discovery_cells
       WHERE pass_id = ? AND status = 'pending'
       ORDER BY id ASC LIMIT ?`,
    )
    .bind(passId, need)
    .all<{ id: string; lat: number; lng: number }>();

  let n = 0;
  for (const c of cells.results ?? []) {
    await enqueueJob(
      db,
      "filter_cell",
      { lat: c.lat, lng: c.lng, cell_id: c.id, pass_id: passId, mode: state.pass_mode },
      `filter:${passId}:${c.id}`,
    );
    n += 1;
  }
  return n;
}

export async function markCellDone(
  db: D1Database,
  passId: number,
  cellId: string,
  placesFound: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE discovery_cells SET status = 'done', places_found = ?, updated_at = ?
       WHERE pass_id = ? AND id = ?`,
    )
    .bind(placesFound, nowIso(), passId, cellId)
    .run();
}

export async function markCellError(db: D1Database, passId: number, cellId: string, err: string): Promise<void> {
  await db
    .prepare(
      `UPDATE discovery_cells SET status = 'error', updated_at = ?
       WHERE pass_id = ? AND id = ?`,
    )
    .bind(nowIso(), passId, cellId)
    .run();
  await emit(db, `cell ${cellId} error: ${err}`, "error");
}

export async function passProgress(db: D1Database) {
  const state = await getState(db);
  const passId = state.pass_id || 0;
  if (!passId) {
    return { pass_id: 0, mode: "", continuous_paused: true, pending: 0, done: 0, error: 0, total: 0 };
  }
  const rows = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM discovery_cells WHERE pass_id = ? GROUP BY status`)
    .bind(passId)
    .all<{ status: string; n: number }>();
  const counts: Record<string, number> = {};
  for (const r of rows.results ?? []) counts[r.status] = r.n;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    pass_id: passId,
    mode: state.pass_mode || "",
    continuous_paused: !!state.continuous_paused,
    pending: counts.pending || 0,
    done: counts.done || 0,
    error: counts.error || 0,
    total,
  };
}

export async function maybeCompletePass(db: D1Database): Promise<boolean> {
  const state = await getState(db);
  if (!state.pass_id || !state.pass_mode) return false;
  if (state.continuous_paused) return false;

  const prog = await passProgress(db);
  const pendingJobs = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')`)
    .first<{ n: number }>();
  if (prog.pending === 0 && (pendingJobs?.n ?? 0) === 0) {
    await db
      .prepare(`UPDATE crawler_state SET continuous_paused = 1, pass_mode = '', updated_at = ? WHERE id = 1`)
      .bind(nowIso())
      .run();
    await emit(
      db,
      `pass #${prog.pass_id} complete — ${prog.done} cells done, ${prog.error} errors. Archive intact (append-only).`,
    );
    return true;
  }
  return false;
}

export async function updateTileManifest(
  db: D1Database,
  version: number,
  placeCount: number,
  r2Key: string,
  bytes: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tile_manifest SET version = ?, built_at = ?, place_count = ?, r2_key = ?, bytes = ? WHERE id = 1`,
    )
    .bind(version, nowIso(), placeCount, r2Key, bytes)
    .run();
}

export function filterUrl(lat: number, lng: number): string {
  const qs = new URLSearchParams({
    latitude: lat.toFixed(6),
    longitude: lng.toFixed(6),
  });
  return `${GUEST}/lieuxGetFilter.php?${qs}`;
}

export function commentsUrl(placeId: string): string {
  const qs = new URLSearchParams({ lieu_id: placeId });
  return `${GUEST}/commGet.php?${qs}`;
}

export async function fetchJson(url: string): Promise<{ status: number; body: string; data: unknown }> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "p5n/0.1 (cloudflare-workers; +https://github.com/irgipaulius/p5n)",
      Accept: "application/json",
      "Axios-Ajax": "true",
    },
  });
  const body = await resp.text();
  return { status: resp.status, body, data: JSON.parse(body) };
}

export function ensureEnvDefaults(env: Env): { maxPlaces: number; delayMs: number; lat: number; lng: number } {
  return {
    maxPlaces: Number(env.MAX_PLACES || 10),
    delayMs: Number(env.REQUEST_DELAY_MS || 300),
    lat: Number(env.DEFAULT_LAT || 41.688908),
    lng: Number(env.DEFAULT_LNG || 19.641004),
  };
}

export { readDb, writeDb };
