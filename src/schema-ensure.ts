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
  ]) {
    await trySql(db, sql);
  }
}
