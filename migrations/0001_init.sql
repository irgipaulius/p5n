-- p5n D1 schema (append-only snapshots + durable jobs)

CREATE TABLE crawler_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  max_places INTEGER NOT NULL DEFAULT 10,
  places_crawled INTEGER NOT NULL DEFAULT 0,
  request_delay_ms INTEGER NOT NULL DEFAULT 300,
  updated_at TEXT NOT NULL
);

INSERT INTO crawler_state (id, paused, max_places, places_crawled, request_delay_ms, updated_at)
VALUES (1, 0, 10, 0, 300, datetime('now'));

CREATE TABLE places_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  lat REAL,
  lng REAL,
  name TEXT,
  code TEXT,
  country TEXT,
  city TEXT,
  rating REAL,
  review_count INTEGER,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_places_place_id ON places_snapshots(place_id);

CREATE TABLE reviews_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  rating REAL,
  author TEXT,
  created_at TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_reviews_place ON reviews_snapshots(place_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until REAL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT
);

CREATE TABLE known_places (
  place_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  reviews_fetched INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE raw_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  bytes_raw INTEGER NOT NULL,
  body_text TEXT NOT NULL
);
