CREATE TABLE IF NOT EXISTS tile_chunks (
  chunk_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  place_count INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tile_chunks_version ON tile_chunks(version);
