-- Coverage log for gap-fill discovery (skip re-querying saturated areas)

CREATE TABLE IF NOT EXISTS discovery_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  wire_count INTEGER NOT NULL,
  new_count INTEGER NOT NULL,
  cap_hit INTEGER NOT NULL DEFAULT 0,
  subdivided INTEGER NOT NULL DEFAULT 0,
  queried_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dq_lat_lng ON discovery_queries(lat, lng);
CREATE INDEX IF NOT EXISTS idx_dq_pass ON discovery_queries(pass_id);

ALTER TABLE crawler_state ADD COLUMN gap_grid_index INTEGER NOT NULL DEFAULT 0;
