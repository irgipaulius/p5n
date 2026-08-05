import type { CommentApi, CrawlerState, Env, JobKind, JobRow, PlaceApi } from "./types";

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

export async function knownPlacesCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM known_places").first<{ n: number }>();
  return row?.n ?? 0;
}

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

/** Prefer discovery → rescrape → refresh → reviews. Honors pending backoff via lease_until. */
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

/** Success → done. Transient failure → pending with backoff. Exhausted → error. */
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

/** @deprecated use resolveJob */
export async function finishJob(db: D1Database, jobId: string, owner: string, error?: string): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs SET status = ?, last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ?`,
    )
    .bind(error ? "error" : "done", error ?? null, nowIso(), jobId, owner)
    .run();
}

/** Drop multilingual bloat — one description + core fields. */
export function slimPlace(place: PlaceApi): Record<string, unknown> {
  const desc =
    [place.description_en, place.description_fr, place.description_de, place.description_it, place.description_es, place.description_nl]
      .map((d) => String(d || "").trim())
      .find(Boolean) || "";

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
    nb_places: place.nb_places,
    prix_stationnement: place.prix_stationnement,
    prix_services: place.prix_services,
    date_fermeture: place.date_fermeture,
    hauteur_limite: place.hauteur_limite,
    tel: place.tel,
    mail: place.mail,
    site_internet: place.site_internet,
    photos: place.photos,
    description: desc,
    // service flags worth keeping if present
    wifi: place.wifi,
    douche: place.douche,
    electricite: place.electricite,
    animaux: place.animaux,
  };
}

async function writePlaceSnapshot(db: D1Database, place: PlaceApi, scrapedAt: string): Promise<void> {
  const placeId = String(place.id);
  const name = String(place.name || "").trim() || String(place.titre || "").trim();
  const slim = slimPlace(place);
  await db
    .prepare(
      `INSERT INTO places_snapshots
       (place_id, scraped_at, lat, lng, name, code, country, city, rating, review_count, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      placeId,
      scrapedAt,
      place.latitude ? Number(place.latitude) : null,
      place.longitude ? Number(place.longitude) : null,
      name,
      place.code ?? null,
      place.pays ?? null,
      place.ville ?? null,
      place.note_moyenne ? Number(place.note_moyenne) : null,
      place.nb_commentaires ? Number(place.nb_commentaires) : 0,
      JSON.stringify(slim),
    )
    .run();
}

/**
 * Discovery ingest: NEW places only (up to cap). Never rewrites known places here.
 * Returns new places + known places seen in this filter (for deferred refresh queue).
 */
export async function ingestNewPlacesFromFilter(
  db: D1Database,
  places: PlaceApi[],
  wireBytes: number,
): Promise<{ newCount: number; newIds: string[]; knownSeen: PlaceApi[] }> {
  const state = await getState(db);
  const cap = state.max_places;
  const scrapedAt = nowIso();
  let known = await knownPlacesCount(db);
  let slots = Math.max(0, cap - known);

  const fresh: PlaceApi[] = [];
  const knownSeen: PlaceApi[] = [];

  for (const place of places) {
    const placeId = String(place.id);
    const existing = await db
      .prepare("SELECT place_id FROM known_places WHERE place_id = ?")
      .bind(placeId)
      .first();
    if (existing) {
      knownSeen.push(place);
      continue;
    }
    if (slots <= 0) continue;
    fresh.push(place);
    slots -= 1;
  }

  // Tiny meta only — do not archive full filter / multi-lang blobs
  await db
    .prepare(
      `INSERT INTO raw_responses (url, fetched_at, http_status, bytes_raw, body_text)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      "filter:meta",
      scrapedAt,
      200,
      wireBytes,
      JSON.stringify({ kind: "filter_meta", wire_bytes: wireBytes, new: fresh.length, known_seen: knownSeen.length }),
    )
    .run();

  for (const place of fresh) {
    const placeId = String(place.id);
    await writePlaceSnapshot(db, place, scrapedAt);
    await db
      .prepare(
        `INSERT INTO known_places (place_id, first_seen_at, last_seen_at, reviews_fetched)
         VALUES (?, ?, ?, 0)`,
      )
      .bind(placeId, scrapedAt, scrapedAt)
      .run();
  }

  const count = await knownPlacesCount(db);
  await db
    .prepare("UPDATE crawler_state SET places_crawled = ?, updated_at = ? WHERE id = 1")
    .bind(count, scrapedAt)
    .run();

  return {
    newCount: fresh.length,
    newIds: fresh.map((p) => String(p.id)),
    knownSeen,
  };
}

/** Deferred update path — append-only new snapshot for an already-known place. */
export async function refreshKnownPlace(db: D1Database, place: PlaceApi): Promise<void> {
  const placeId = String(place.id);
  const known = await db
    .prepare("SELECT place_id FROM known_places WHERE place_id = ?")
    .bind(placeId)
    .first();
  if (!known) return;
  const scrapedAt = nowIso();
  await writePlaceSnapshot(db, place, scrapedAt);
  await db
    .prepare("UPDATE known_places SET last_seen_at = ? WHERE place_id = ?")
    .bind(scrapedAt, placeId)
    .run();
}

export async function ingestReviews(
  db: D1Database,
  placeId: string,
  url: string,
  status: number,
  body: string,
  comments: CommentApi[],
): Promise<number> {
  const scrapedAt = nowIso();
  // Store slim review rows only — skip full raw body archive
  for (const c of comments) {
    await db
      .prepare(
        `INSERT INTO reviews_snapshots
         (review_id, place_id, scraped_at, rating, author, created_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        String(c.id),
        placeId,
        scrapedAt,
        c.note ? Number(c.note) : null,
        c.uuid ?? null,
        c.date_creation ?? null,
        JSON.stringify({
          id: c.id,
          note: c.note,
          commentaire: c.commentaire,
          uuid: c.uuid,
          date_creation: c.date_creation,
          type_vehicule: c.type_vehicule,
        }),
      )
      .run();
  }

  await db
    .prepare("UPDATE known_places SET reviews_fetched = 1, last_seen_at = ? WHERE place_id = ?")
    .bind(scrapedAt, placeId)
    .run();

  return comments.length;
}

export async function reviewsFetched(db: D1Database, placeId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT reviews_fetched FROM known_places WHERE place_id = ?")
    .bind(placeId)
    .first<{ reviews_fetched: number }>();
  return !!row?.reviews_fetched;
}

export async function getStats(db: D1Database) {
  const state = await getState(db);
  const jobs = await db
    .prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
    .all<{ status: string; n: number }>();
  const known = await knownPlacesCount(db);
  const placeSnapshots =
    (await db.prepare("SELECT COUNT(*) AS n FROM places_snapshots").first<{ n: number }>())?.n ?? 0;
  const reviewSnapshots =
    (await db.prepare("SELECT COUNT(*) AS n FROM reviews_snapshots").first<{ n: number }>())?.n ?? 0;
  const rawBytes =
    (await db.prepare("SELECT COALESCE(SUM(bytes_raw), 0) AS n FROM raw_responses").first<{ n: number }>())
      ?.n ?? 0;

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
    known_places: known,
    place_snapshots: placeSnapshots,
    review_snapshots: reviewSnapshots,
    raw_bytes: rawBytes,
    pass,
  };
}

export async function listPlaces(db: D1Database, limit = 50) {
  const res = await db
    .prepare(
      `SELECT p.place_id, p.name, p.lat, p.lng, p.country, p.city, p.rating,
              p.review_count, p.scraped_at, k.reviews_fetched
       FROM places_snapshots p
       JOIN (
         SELECT place_id, MAX(id) AS max_id FROM places_snapshots GROUP BY place_id
       ) latest ON p.id = latest.max_id
       JOIN known_places k ON k.place_id = p.place_id
       ORDER BY CAST(p.place_id AS INTEGER)
       LIMIT ?`,
    )
    .bind(limit)
    .all();
  return res.results ?? [];
}

/** Compact pin payload — includes type code for map styling. */
export async function listPlacesGeo(db: D1Database) {
  const res = await db
    .prepare(
      `SELECT p.id AS snapshot_id, p.place_id AS id, p.lat, p.lng, p.name, p.code, p.rating, p.review_count AS reviews
       FROM places_snapshots p
       JOIN (
         SELECT place_id, MAX(id) AS max_id FROM places_snapshots GROUP BY place_id
       ) latest ON p.id = latest.max_id
       WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL`,
    )
    .all<{
      snapshot_id: number;
      id: string;
      lat: number;
      lng: number;
      name: string;
      code: string | null;
      rating: number | null;
      reviews: number;
    }>();
  return res.results ?? [];
}

/** New/updated place pins since a places_snapshots row id (for SSE). */
export async function listPlacesGeoSince(db: D1Database, afterSnapshotId: number) {
  const res = await db
    .prepare(
      `SELECT p.id AS snapshot_id, p.place_id AS id, p.lat, p.lng, p.name, p.code, p.rating, p.review_count AS reviews
       FROM places_snapshots p
       JOIN (
         SELECT place_id, MAX(id) AS max_id FROM places_snapshots GROUP BY place_id
       ) latest ON p.id = latest.max_id
       WHERE p.id > ? AND p.lat IS NOT NULL AND p.lng IS NOT NULL
       ORDER BY p.id ASC
       LIMIT 100`,
    )
    .bind(afterSnapshotId)
    .all<{
      snapshot_id: number;
      id: string;
      lat: number;
      lng: number;
      name: string;
      code: string | null;
      rating: number | null;
      reviews: number;
    }>();
  return res.results ?? [];
}

export async function maxSnapshotId(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM places_snapshots")
    .first<{ n: number }>();
  return row?.n ?? 0;
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

/** Full latest places_snapshots row (+ optional reviews) for pin click. */
export async function getPlaceFull(db: D1Database, placeId: string) {
  const row = await db
    .prepare(
      `SELECT p.*
       FROM places_snapshots p
       JOIN (
         SELECT place_id, MAX(id) AS max_id FROM places_snapshots GROUP BY place_id
       ) latest ON p.id = latest.max_id
       WHERE p.place_id = ?`,
    )
    .bind(placeId)
    .first();
  if (!row) return null;

  const reviews = await db
    .prepare(
      `SELECT r.*
       FROM reviews_snapshots r
       JOIN (
         SELECT review_id, MAX(id) AS max_id FROM reviews_snapshots WHERE place_id = ? GROUP BY review_id
       ) latest ON r.id = latest.max_id
       WHERE r.place_id = ?
       ORDER BY r.created_at DESC`,
    )
    .bind(placeId, placeId)
    .all();

  let payload: unknown = row.payload_json;
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch {
    /* keep string */
  }

  return {
    ...row,
    payload_json: payload,
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

  // Archive pass: raise cap so discovery isn't blocked; never delete existing spots.
  await db
    .prepare(
      `UPDATE crawler_state SET pass_id = ?, pass_mode = ?, continuous_paused = 0,
       max_places = ?, places_crawled = places_crawled, updated_at = ? WHERE id = 1`,
    )
    .bind(passId, mode, 50_000_000, t)
    .run();

  // Batch insert cells
  const stmts = cells.map((c) =>
    db
      .prepare(
        `INSERT INTO discovery_cells (id, pass_id, lat, lng, status, places_found, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .bind(c.id, passId, c.lat, c.lng, t),
  );
  // D1 batch limit ~1000 statements — chunk
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
    return { pass_id: 0, mode: "", pending: 0, done: 0, error: 0, total: 0 };
  }
  const rows = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM discovery_cells WHERE pass_id = ? GROUP BY status`,
    )
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
        `UPDATE crawler_state SET continuous_paused = 1, pass_mode = '', updated_at = ? WHERE id = 1`,
      )
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
