-- Dashboard PMTiles bake: phase tracking + D1 blob fallback when R2 is unavailable
ALTER TABLE tile_manifest ADD COLUMN bake_phase TEXT;

CREATE TABLE IF NOT EXISTS tile_blob (
  key TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
