-- Track in-worker tile bake progress (dashboard button)
ALTER TABLE tile_manifest ADD COLUMN bake_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE tile_manifest ADD COLUMN bake_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tile_manifest ADD COLUMN bake_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tile_manifest ADD COLUMN bake_error TEXT;
ALTER TABLE tile_manifest ADD COLUMN bake_started_at TEXT;
