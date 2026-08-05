-- Continuous archive crawl state + geo discovery grid (append-only places forever)

ALTER TABLE crawler_state ADD COLUMN continuous_paused INTEGER NOT NULL DEFAULT 1;
ALTER TABLE crawler_state ADD COLUMN pass_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawler_state ADD COLUMN pass_mode TEXT NOT NULL DEFAULT '';
-- '' | full | new_only

CREATE TABLE IF NOT EXISTS discovery_cells (
  id TEXT NOT NULL,
  pass_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  status TEXT NOT NULL,
  places_found INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pass_id, id)
);
CREATE INDEX IF NOT EXISTS idx_cells_pass_status ON discovery_cells(pass_id, status);
