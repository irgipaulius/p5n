import { encodeAttributes, extractPhotoUrls, MAX_REVIEWS_PER_PLACE, photoCountFrom, typeCode, typeToInt } from "./attributes";
import { labelForCode } from "../shared/place-types";
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

/** Stay under Workers Free 50 D1 statements per invocation (~3 stmts/place). */
export const INGEST_CHUNK_SIZE = 6;

/** D1 free tier is 5 GB — stop scraping before we hit the wall. */
export const DB_SIZE_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024 * 1024);

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

export async function enqueueJobsBatch(
  db: D1Database,
  items: { kind: JobKind; payload: Record<string, unknown>; id: string }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const t = nowIso();
  for (let i = 0; i < items.length; i += 15) {
    const slice = items.slice(i, i + 15);
    await db.batch(
      slice.map((item) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO jobs (id, kind, payload_json, status, attempts, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
          )
          .bind(item.id, item.kind, JSON.stringify(item.payload), t, t),
      ),
    );
  }
  return items.length;
}

/** (Re)queue filter_cell jobs — revives done/error rows for cells still pending. */
export async function enqueueFilterCellJobs(
  db: D1Database,
  items: { id: string; payload: Record<string, unknown> }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const t = nowIso();
  let n = 0;
  for (let i = 0; i < items.length; i += 12) {
    const slice = items.slice(i, i + 12);
    await db.batch(
      slice.map((item) =>
        db
          .prepare(
            `INSERT INTO jobs (id, kind, payload_json, status, attempts, created_at, updated_at)
             VALUES (?, 'filter_cell', ?, 'pending', 0, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               payload_json = excluded.payload_json,
               status = 'pending',
               attempts = 0,
               last_error = NULL,
               lease_owner = NULL,
               lease_until = NULL,
               updated_at = excluded.updated_at
             WHERE jobs.status IN ('done', 'error')`,
          )
          .bind(item.id, JSON.stringify(item.payload), t, t),
      ),
    );
    n += slice.length;
  }
  return n;
}

export async function claimJob(db: D1Database, owner: string, leaseSeconds = 60): Promise<JobRow | null> {
  const state = await getState(db);
  if (state.paused || state.storage_handbrake) return null;

  const now = Date.now() / 1000;
  const row = await db
    .prepare(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY CASE kind
         WHEN 'ingest_chunk' THEN 0
         WHEN 'filter_cell' THEN 1
         WHEN 'place_reviews' THEN 2
         WHEN 'rescrape_place' THEN 3
         WHEN 'place_refresh' THEN 4
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
  return String(place.description_en || "").trim();
}

export function slimPlace(place: PlaceApi): Record<string, unknown> {
  const photos = extractPhotoUrls(place);
  const photoCount = photoCountFrom(place) || photos.length;
  return {
    description: pickDescription(place),
    route: place.route ?? null,
    hauteur_limite: place.hauteur_limite ?? null,
    prix_stationnement: place.prix_stationnement ?? null,
    prix_services: place.prix_services ?? null,
    date_fermeture: place.date_fermeture ?? null,
    nb_places: place.nb_places ?? null,
    site: place.site_internet ?? null,
    tel: place.tel ?? null,
    mail: place.mail ?? null,
    nb_photos: photoCount,
    photos,
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
  photoCount: number;
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
    photoCount: photoCountFrom(place),
    description: pickDescription(place),
    geohash4: g4,
    geohash6: g6,
  };
}

function placeUpsertStatements(
  db: D1Database,
  p: ReturnType<typeof placeFromApi>,
  detailJson: string,
  scrapedAt: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO places (
          place_id, source, lat, lng, geohash4, geohash6, type, rating, review_count,
          attrs0, attrs1, photo_count, name, city, country, updated_at, reviews_fetched
        ) VALUES (?, 'p4n', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(place_id) DO UPDATE SET
          lat = excluded.lat, lng = excluded.lng,
          geohash4 = excluded.geohash4, geohash6 = excluded.geohash6,
          type = excluded.type, rating = excluded.rating, review_count = excluded.review_count,
          attrs0 = excluded.attrs0, attrs1 = excluded.attrs1, photo_count = excluded.photo_count,
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
        p.photoCount,
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
      .prepare("INSERT INTO places_fts (place_id, name, city, description) VALUES (?, ?, ?, ?)")
      .bind(p.placeId, p.name, p.city ?? "", p.description),
  ];
}

async function upsertPlaceBatch(db: D1Database, place: PlaceApi, scrapedAt: string): Promise<boolean> {
  const p = placeFromApi(place);
  const existing = await db
    .prepare("SELECT place_id FROM places WHERE place_id = ?")
    .bind(p.placeId)
    .first();

  const detailJson = JSON.stringify(slimPlace(place));
  const stmts = placeUpsertStatements(db, p, detailJson, scrapedAt);

  if (existing) {
    await db.batch([
      stmts[0],
      stmts[1],
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

async function existingPlaceIdsSet(db: D1Database, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    if (slice.length === 0) continue;
    const placeholders = slice.map(() => "?").join(",");
    const res = await db
      .prepare(`SELECT place_id FROM places WHERE place_id IN (${placeholders})`)
      .bind(...slice)
      .all<{ place_id: string }>();
    for (const row of res.results ?? []) found.add(row.place_id);
  }
  return found;
}

/** Split a filter response into small ingest jobs — filter_cell must stay under 50 D1 stmts. */
export async function planAndEnqueueFilterIngest(
  db: D1Database,
  places: PlaceApi[],
  meta: { lat: number; lng: number; cellId?: string | null; passId?: number | null },
): Promise<{ newCount: number; knownSeen: PlaceApi[]; chunks: number }> {
  const state = await getState(db);
  if (state.storage_handbrake) {
    return { newCount: 0, knownSeen: places, chunks: 0 };
  }

  const cap = state.max_places;
  const known = await placesCount(db);
  let slots = Math.max(0, cap - known);

  const existingSet = await existingPlaceIdsSet(
    db,
    places.map((p) => String(p.id)),
  );

  const fresh: PlaceApi[] = [];
  const knownSeen: PlaceApi[] = [];
  for (const place of places) {
    const placeId = String(place.id);
    if (existingSet.has(placeId)) {
      knownSeen.push(place);
      continue;
    }
    if (slots <= 0) continue;
    fresh.push(place);
    slots -= 1;
  }

  if (fresh.length === 0) {
    return { newCount: 0, knownSeen, chunks: 0 };
  }

  const scrapedAt = nowIso();
  const cellKey = meta.cellId ?? `${meta.lat},${meta.lng}`;
  const passKey = meta.passId != null ? String(meta.passId) : "0";
  const jobs: { kind: JobKind; payload: Record<string, unknown>; id: string }[] = [];

  for (let i = 0; i < fresh.length; i += INGEST_CHUNK_SIZE) {
    const chunk = fresh.slice(i, i + INGEST_CHUNK_SIZE);
    jobs.push({
      kind: "ingest_chunk",
      id: `ingest:${passKey}:${cellKey}:${i}`,
      payload: { places: chunk, scraped_at: scrapedAt },
    });
  }

  await enqueueJobsBatch(db, jobs);
  return { newCount: fresh.length, knownSeen, chunks: jobs.length };
}

/** Ingest up to INGEST_CHUNK_SIZE new places in one job (no per-pin run_events). */
export async function ingestPlacesChunk(db: D1Database, places: PlaceApi[], scrapedAt: string): Promise<number> {
  if (places.length === 0) return 0;

  const stmts: D1PreparedStatement[] = [];
  for (const place of places) {
    const p = placeFromApi(place);
    stmts.push(...placeUpsertStatements(db, p, JSON.stringify(slimPlace(place)), scrapedAt));
  }

  for (let i = 0; i < stmts.length; i += 45) {
    await db.batch(stmts.slice(i, i + 45));
  }

  const count = await placesCount(db);
  await db
    .prepare("UPDATE crawler_state SET places_crawled = ?, updated_at = ? WHERE id = 1")
    .bind(count, scrapedAt)
    .run();

  return places.length;
}

export async function ingestNewPlacesFromFilter(
  db: D1Database,
  places: PlaceApi[],
  wireBytes: number,
): Promise<{ newCount: number; newIds: string[]; knownSeen: PlaceApi[] }> {
  const { newCount, knownSeen } = await planAndEnqueueFilterIngest(db, places, {
    lat: 0,
    lng: 0,
    cellId: null,
    passId: null,
  });
  await emit(db, `filter ingest queued: +${newCount} new (wire=${wireBytes}B)`, "info", {
    wire_bytes: wireBytes,
    new: newCount,
    known_seen: knownSeen.length,
  });
  return {
    newCount,
    newIds: [],
    knownSeen,
  };
}

export async function refreshKnownPlace(db: D1Database, place: PlaceApi): Promise<void> {
  const placeId = String(place.id);
  const known = await db.prepare("SELECT place_id FROM places WHERE place_id = ?").bind(placeId).first();
  if (!known) return;
  await upsertPlaceBatch(db, place, nowIso());
}

export function capReviewComments(comments: CommentApi[]): CommentApi[] {
  return [...comments]
    .sort((a, b) => String(b.date_creation || "").localeCompare(String(a.date_creation || "")))
    .slice(0, MAX_REVIEWS_PER_PLACE);
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
  const capped = capReviewComments(comments);

  await db.prepare("DELETE FROM reviews WHERE place_id = ?").bind(placeId).run();
  await db.prepare("DELETE FROM reviews_fts WHERE place_id = ?").bind(placeId).run();

  const stmts: D1PreparedStatement[] = [];
  for (const c of capped) {
    const reviewId = String(c.id);
    const comment = String(c.commentaire || "").trim();
    if (!comment) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO reviews (review_id, place_id, rating, author, created_at, comment, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(review_id, place_id) DO UPDATE SET
             rating = excluded.rating, author = excluded.author, created_at = excluded.created_at,
             comment = excluded.comment, scraped_at = excluded.scraped_at`,
        )
        .bind(
          reviewId,
          placeId,
          c.note ? Number(c.note) : null,
          c.uuid ?? null,
          c.date_creation ?? null,
          comment,
          scrapedAt,
        ),
    );
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

  return capped.filter((c) => String(c.commentaire || "").trim()).length;
}

async function estimateDbBytesFromTables(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM places) AS n_places,
        (SELECT COUNT(*) FROM reviews) AS n_reviews,
        (SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM place_details) AS detail_len,
        (SELECT COALESCE(SUM(LENGTH(comment)), 0) FROM reviews) AS comment_len`,
    )
    .first<{ n_places: number; n_reviews: number; detail_len: number; comment_len: number }>();
  if (!row) return 0;
  // ~11 KB/pin observed on slim schema (includes indexes + FTS overhead)
  return Math.round(row.n_places * 11_000 + row.n_reviews * 320 + row.detail_len + row.comment_len);
}

export async function measureDbBytes(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat").first<{ bytes: number }>();
    if (row?.bytes) return row.bytes;
  } catch {
    /* dbstat not available in D1 */
  }
  try {
    const row = await db
      .prepare(
        `SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS bytes`,
      )
      .first<{ bytes: number }>();
    if (row?.bytes) return row.bytes;
  } catch {
    /* pragma blocked in worker/D1 context */
  }
  return estimateDbBytesFromTables(db);
}

export async function checkStorageHandbrake(db: D1Database): Promise<boolean> {
  const state = await getState(db);
  if (state.storage_handbrake) return true;

  const bytes = await measureDbBytes(db);
  if (bytes < DB_SIZE_LIMIT_BYTES) return false;

  const res = await db
    .prepare(
      "UPDATE crawler_state SET paused = 1, storage_handbrake = 1, updated_at = ? WHERE id = 1 AND storage_handbrake = 0",
    )
    .bind(nowIso())
    .run();

  if ((res.meta.changes ?? 0) > 0) {
    await emit(
      db,
      `STORAGE HANDBRAKE — DB ${(bytes / (1024 * 1024)).toFixed(1)} MB ≥ ${(DB_SIZE_LIMIT_BYTES / (1024 * 1024)).toFixed(0)} MB limit. Scraper stopped; schema refactor required.`,
      "error",
      { db_bytes: bytes, limit_bytes: DB_SIZE_LIMIT_BYTES },
    );
  }
  return true;
}

export async function advancePass(db: D1Database): Promise<void> {
  await queueNextDiscoveryCells(db, 24);
  await maybeCompletePass(db);
  await checkStorageHandbrake(db);
}

/** True while Europe pass or job queue still has work. */
export async function crawlWorkRemaining(db: D1Database): Promise<boolean> {
  const state = await getState(db);
  if (state.paused || state.storage_handbrake) return false;

  const activeJobs = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending', 'running')`)
    .first<{ n: number }>();
  if ((activeJobs?.n ?? 0) > 0) return true;

  const passId = state.pass_id || 0;
  if (!passId || !state.pass_mode || state.continuous_paused) return false;

  const pendingCells = await db
    .prepare(`SELECT COUNT(*) AS n FROM discovery_cells WHERE pass_id = ? AND status = 'pending'`)
    .bind(passId)
    .first<{ n: number }>();
  return (pendingCells?.n ?? 0) > 0;
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

  const dbBytes = await measureDbBytes(db);

  return {
    state,
    jobs: jobMap,
    places: known,
    reviews: reviewCount,
    db_bytes: dbBytes,
    db_mb: Math.round((dbBytes / (1024 * 1024)) * 100) / 100,
    db_limit_mb: Math.round(DB_SIZE_LIMIT_BYTES / (1024 * 1024)),
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

export async function emitPin(db: D1Database, pin: PinGeo): Promise<void> {
  await emit(db, pin.name || pin.id, "pin", { pin });
}

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

export interface GeoCursor {
  at: string;
  id: string;
}

export async function listPlacesGeoSince(env: Env, cursor: GeoCursor): Promise<PinGeo[]> {
  const res = await readDb(env)
    .prepare(
      `SELECT place_id, lat, lng, type, name, updated_at FROM places
       WHERE lat IS NOT NULL AND lng IS NOT NULL
         AND (updated_at > ? OR (updated_at = ? AND place_id > ?))
       ORDER BY updated_at ASC, place_id ASC LIMIT 200`,
    )
    .bind(cursor.at, cursor.at, cursor.id)
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
    minRating?: number;
    hasPhotos?: boolean;
    offset: number;
    limit: number;
  },
): Promise<SearchPin[]> {
  const { q, attrs0, attrs1, type, minRating, hasPhotos, offset, limit } = opts;
  const binds: (string | number)[] = [];
  let sql: string;

  const extraFilters = (alias: string): string => {
    let clause = "";
    if (type) {
      clause += ` AND ${alias}.type = ?`;
      binds.push(type);
    }
    if (attrs0 != null && attrs0 !== 0) {
      clause += ` AND (${alias}.attrs0 & ?) = ?`;
      binds.push(attrs0, attrs0);
    }
    if (attrs1 != null && attrs1 !== 0) {
      clause += ` AND (${alias}.attrs1 & ?) = ?`;
      binds.push(attrs1, attrs1);
    }
    if (minRating != null && minRating > 0) {
      clause += ` AND ${alias}.rating >= ?`;
      binds.push(minRating);
    }
    if (hasPhotos) {
      clause += ` AND ${alias}.photo_count > 0`;
    }
    return clause;
  };

  if (q && q.trim()) {
    const term = q.trim().replace(/"/g, '""');
    const match = `"${term}"* OR ${term}*`;
    sql = `SELECT p.place_id, p.lat, p.lng, p.type, p.name, p.rating, p.review_count, hits.score
           FROM (
             SELECT place_id, MIN(score) AS score FROM (
               SELECT place_id, bm25(places_fts) AS score FROM places_fts WHERE places_fts MATCH ?
               UNION ALL
               SELECT place_id, bm25(reviews_fts) AS score FROM reviews_fts WHERE reviews_fts MATCH ?
             ) GROUP BY place_id
           ) hits
           JOIN places p ON p.place_id = hits.place_id
           WHERE 1=1`;
    binds.push(match, match);
    sql += extraFilters("p");
    sql += " ORDER BY hits.score ASC, p.rating DESC NULLS LAST LIMIT ? OFFSET ?";
  } else {
    sql = `SELECT place_id, lat, lng, type, name, rating, review_count, 0 AS score FROM places WHERE 1=1`;
    sql += extraFilters("places");
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

export async function getPlaceFull(env: Env, placeId: string, opts: { includeReviews?: boolean } = {}) {
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

  let detail: Record<string, unknown> | null = null;
  if (row.detail_json) {
    try {
      detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    } catch {
      detail = null;
    }
  }

  const base = {
    place_id: row.place_id,
    lat: row.lat,
    lng: row.lng,
    type: row.type,
    type_label: labelForCode(row.type),
    rating: row.rating,
    review_count: row.review_count,
    photo_count: row.photo_count ?? 0,
    attrs0: row.attrs0,
    attrs1: row.attrs1,
    name: row.name,
    city: row.city,
    country: row.country,
    updated_at: row.updated_at,
    detail,
  };

  if (!opts.includeReviews) return base;

  const reviews = await readDb(env)
    .prepare(
      `SELECT review_id, rating, author, created_at, comment
       FROM reviews WHERE place_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(placeId, MAX_REVIEWS_PER_PLACE)
    .all();

  return { ...base, reviews: reviews.results ?? [] };
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

export async function queueNextDiscoveryCells(db: D1Database, limit = 50): Promise<number> {
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

  const jobs = (cells.results ?? []).map((c) => ({
    id: `filter:${passId}:${c.id}`,
    payload: {
      lat: c.lat,
      lng: c.lng,
      cell_id: c.id,
      pass_id: passId,
      mode: state.pass_mode,
    },
  }));
  return enqueueFilterCellJobs(db, jobs);
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
      .prepare(
        `UPDATE crawler_state SET paused = 1, continuous_paused = 1, pass_mode = '', updated_at = ? WHERE id = 1`,
      )
      .bind(nowIso())
      .run();
    await emit(
      db,
      `Scrape complete — pass #${prog.pass_id}: ${prog.done} cells done, ${prog.error} errors. Scraper idle.`,
      "info",
      { pass_id: prog.pass_id, done: prog.done, error: prog.error },
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

let lastOutboundFetchAt = 0;

function rateLimitMs(env: Env, state?: CrawlerState): number {
  const fromEnv = Number(env.REQUEST_DELAY_MS || 200);
  if (fromEnv > 0) return Math.max(150, fromEnv);
  const fromDb = state?.request_delay_ms;
  return Math.max(150, fromDb || 200);
}

/** One outbound HTTP request at a time globally, with cooldown after each completes. */
async function withOutboundGate<T>(db: D1Database, gapMs: number, fn: () => Promise<T>): Promise<T> {
  const maxHoldSec = 120;

  for (;;) {
    const now = Date.now() / 1000;
    const res = await db
      .prepare(
        `UPDATE crawler_state SET outbound_lock_until = ?
         WHERE id = 1 AND (outbound_lock_until IS NULL OR outbound_lock_until <= ?)`,
      )
      .bind(now + maxHoldSec, now)
      .run();
    if ((res.meta.changes ?? 0) > 0) break;

    const row = await db
      .prepare("SELECT outbound_lock_until FROM crawler_state WHERE id = 1")
      .first<{ outbound_lock_until: number | null }>();
    const waitMs = Math.max(0, ((row?.outbound_lock_until ?? now) - now) * 1000);
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 500)));
  }

  try {
    return await fn();
  } finally {
    const done = Date.now() / 1000;
    await db
      .prepare("UPDATE crawler_state SET last_outbound_at = ?, outbound_lock_until = ? WHERE id = 1")
      .bind(done, done + gapMs / 1000)
      .run();
    lastOutboundFetchAt = Date.now();
  }
}

/** Only one isolate (SSE tab / cron) drives the job queue at a time. */
export async function tryAcquireCrawlLease(db: D1Database, owner: string, leaseSec = 90): Promise<boolean> {
  const now = Date.now() / 1000;
  const until = now + leaseSec;
  const res = await db
    .prepare(
      `UPDATE crawler_state SET crawl_lease_owner = ?, crawl_lease_until = ?, updated_at = ?
       WHERE id = 1 AND (crawl_lease_until IS NULL OR crawl_lease_until <= ? OR crawl_lease_owner = ?)`,
    )
    .bind(owner, until, nowIso(), now, owner)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function releaseCrawlLease(db: D1Database, owner: string): Promise<void> {
  await db
    .prepare(
      `UPDATE crawler_state SET crawl_lease_owner = NULL, crawl_lease_until = NULL, updated_at = ?
       WHERE id = 1 AND crawl_lease_owner = ?`,
    )
    .bind(nowIso(), owner)
    .run();
}

export async function reclaimCrawlLease(db: D1Database): Promise<boolean> {
  const now = Date.now() / 1000;
  const res = await db
    .prepare(
      `UPDATE crawler_state SET crawl_lease_owner = NULL, crawl_lease_until = NULL, updated_at = ?
       WHERE id = 1 AND crawl_lease_until IS NOT NULL AND crawl_lease_until <= ?`,
    )
    .bind(nowIso(), now)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

function outboundGapMs(env: Env, state: CrawlerState, url: string): number {
  const base = rateLimitMs(env, state);
  // Filter responses carry hundreds of pins each — keep calls moving, still one at a time globally.
  if (url.includes("lieuxGetFilter")) return base;
  return base;
}

export async function fetchJson(env: Env, url: string): Promise<{ status: number; body: string; data: unknown }> {
  const db = writeDb(env);
  const gapMs = outboundGapMs(env, await getState(db), url);
  return withOutboundGate(db, gapMs, async () => {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "p5n/0.1 (cloudflare-workers; +https://github.com/irgipaulius/p5n)",
        Accept: "application/json",
        "Axios-Ajax": "true",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await resp.text();
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`invalid JSON from ${url}: ${body.slice(0, 120)}`);
    }
    return { status: resp.status, body, data };
  });
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
