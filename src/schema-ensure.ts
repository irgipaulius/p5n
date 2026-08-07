/** Idempotent additive schema — runs once per isolate if deploy skipped migrations. */
let ensured = false;

async function trySql(db: D1Database, sql: string): Promise<void> {
  try {
    await db.prepare(sql).run();
  } catch {
    /* column/table already exists */
  }
}

export async function ensureSchema(db: D1Database): Promise<void> {
  if (ensured) return;
  ensured = true;

  await trySql(
    db,
    `CREATE TABLE IF NOT EXISTS tile_chunks (
      chunk_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      built_at TEXT NOT NULL,
      place_count INTEGER NOT NULL DEFAULT 0,
      r2_key TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0
    )`,
  );
  await trySql(db, `CREATE INDEX IF NOT EXISTS idx_tile_chunks_version ON tile_chunks(version)`);

  for (const sql of [
    `ALTER TABLE tile_manifest ADD COLUMN bake_status TEXT NOT NULL DEFAULT 'idle'`,
    `ALTER TABLE tile_manifest ADD COLUMN bake_progress INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tile_manifest ADD COLUMN bake_total INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tile_manifest ADD COLUMN bake_error TEXT`,
    `ALTER TABLE tile_manifest ADD COLUMN bake_started_at TEXT`,
    `ALTER TABLE tile_manifest ADD COLUMN grid_cells INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tile_manifest ADD COLUMN bake_phase TEXT`,
    `ALTER TABLE tile_chunks ADD COLUMN data BLOB`,
  ]) {
    await trySql(db, sql);
  }

  await trySql(
    db,
    `CREATE TABLE IF NOT EXISTS tile_blob (
      key TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
  );

  await trySql(
    db,
    `CREATE TABLE IF NOT EXISTS pin_grid (
      g4 TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL
    )`,
  );
  await trySql(db, `CREATE INDEX IF NOT EXISTS idx_pin_grid_count ON pin_grid(count)`);

  await trySql(
    db,
    `CREATE TABLE IF NOT EXISTS discovery_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pass_id INTEGER NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      wire_count INTEGER NOT NULL,
      new_count INTEGER NOT NULL,
      cap_hit INTEGER NOT NULL DEFAULT 0,
      subdivided INTEGER NOT NULL DEFAULT 0,
      queried_at TEXT NOT NULL
    )`,
  );
  await trySql(db, `CREATE INDEX IF NOT EXISTS idx_dq_lat_lng ON discovery_queries(lat, lng)`);
  await trySql(db, `ALTER TABLE crawler_state ADD COLUMN gap_grid_index INTEGER NOT NULL DEFAULT 0`);
}
