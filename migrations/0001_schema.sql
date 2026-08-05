-- p5n v2: read-optimized geo-indexed schema (fresh start)

CREATE TABLE crawler_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  max_places INTEGER NOT NULL DEFAULT 10,
  places_crawled INTEGER NOT NULL DEFAULT 0,
  request_delay_ms INTEGER NOT NULL DEFAULT 300,
  prefer_new INTEGER NOT NULL DEFAULT 1,
  continuous_paused INTEGER NOT NULL DEFAULT 1,
  pass_id INTEGER NOT NULL DEFAULT 0,
  pass_mode TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT INTO crawler_state (
  id, paused, max_places, places_crawled, request_delay_ms,
  prefer_new, continuous_paused, pass_id, pass_mode, updated_at
) VALUES (1, 0, 10, 0, 300, 1, 1, 0, '', datetime('now'));

-- Read-optimized current place row (one per place_id)
CREATE TABLE places (
  place_id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'p4n',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  geohash4 TEXT NOT NULL,
  geohash6 TEXT NOT NULL,
  type TEXT NOT NULL,
  rating REAL,
  review_count INTEGER NOT NULL DEFAULT 0,
  attrs0 INTEGER NOT NULL DEFAULT 0,
  attrs1 INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  city TEXT,
  country TEXT,
  updated_at TEXT NOT NULL,
  reviews_fetched INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_places_geohash4 ON places(geohash4);
CREATE INDEX idx_places_geohash6 ON places(geohash6);
CREATE INDEX idx_places_type ON places(type);
CREATE INDEX idx_places_lat_lng ON places(lat, lng);
CREATE INDEX idx_places_updated ON places(updated_at);

-- Generic attribute taxonomy (bit_index maps into attrs0/attrs1)
CREATE TABLE attribute_defs (
  bit_index INTEGER PRIMARY KEY,
  column_name TEXT NOT NULL CHECK (column_name IN ('attrs0', 'attrs1')),
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  source_mappings TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO attribute_defs (bit_index, column_name, key, label, source_mappings) VALUES
  (0,  'attrs0', 'wifi',        'WiFi',           '{"p4n":"wifi"}'),
  (1,  'attrs0', 'douche',      'Shower',         '{"p4n":"douche"}'),
  (2,  'attrs0', 'electricite', 'Electricity',    '{"p4n":"electricite"}'),
  (3,  'attrs0', 'animaux',     'Pets allowed',   '{"p4n":"animaux"}'),
  (4,  'attrs0', 'eau',         'Water',          '{"p4n":"eau"}'),
  (5,  'attrs0', 'baignade',    'Swimming',       '{"p4n":"baignade"}'),
  (6,  'attrs0', 'poubelle',    'Rubbish bin',    '{"p4n":"poubelle"}'),
  (7,  'attrs0', 'wc',          'Toilet',         '{"p4n":"wc"}'),
  (8,  'attrs0', 'parking',     'Parking',        '{"p4n":"parking"}'),
  (9,  'attrs0', 'piscine',     'Pool',           '{"p4n":"piscine"}'),
  (10, 'attrs0', 'laverie',     'Laundry',        '{"p4n":"laverie"}'),
  (11, 'attrs0', 'gaz',         'Gas',            '{"p4n":"gaz"}'),
  (12, 'attrs0', 'donnees',     'Mobile data',    '{"p4n":"donnees"}'),
  (13, 'attrs0', 'acces_handi', 'Accessible',     '{"p4n":"acces_handi"}'),
  (14, 'attrs0', 'bbq',         'BBQ',            '{"p4n":"bbq"}'),
  (15, 'attrs0', 'poussette',   'Stroller OK',    '{"p4n":"poussette"}'),
  (16, 'attrs1', 'sport',       'Sports',         '{"p4n":"sport"}'),
  (17, 'attrs1', 'jeux',        'Playground',     '{"p4n":"jeux"}'),
  (18, 'attrs1', 'restaurant',  'Restaurant',     '{"p4n":"restaurant"}'),
  (19, 'attrs1', 'boulangerie', 'Bakery',         '{"p4n":"boulangerie"}'),
  (20, 'attrs1', 'supermarche', 'Supermarket',    '{"p4n":"supermarche"}'),
  (21, 'attrs1', 'pharmacie',   'Pharmacy',       '{"p4n":"pharmacie"}'),
  (22, 'attrs1', 'laverie_auto','Car wash',      '{"p4n":"laverie_auto"}'),
  (23, 'attrs1', 'piste',       'Track/trail',    '{"p4n":"piste"}'),
  (24, 'attrs1', 'peche',       'Fishing',        '{"p4n":"peche"}'),
  (25, 'attrs1', 'velo',        'Cycling',        '{"p4n":"velo"}'),
  (26, 'attrs1', 'ski',         'Ski',            '{"p4n":"ski"}'),
  (27, 'attrs1', 'plongee',     'Diving',         '{"p4n":"plongee"}'),
  (28, 'attrs1', 'location',    'Rental',         '{"p4n":"location"}'),
  (29, 'attrs1', 'visite',      'Visit/tour',     '{"p4n":"visite"}'),
  (30, 'attrs1', 'camping',     'Camping',        '{"p4n":"camping"}'),
  (31, 'attrs1', 'naturiste',   'Naturist',       '{"p4n":"naturiste"}');

-- Heavy detail blob (lazy tier 3)
CREATE TABLE place_details (
  place_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Slim review rows
CREATE TABLE reviews (
  review_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  rating REAL,
  author TEXT,
  created_at TEXT,
  comment TEXT,
  payload_json TEXT,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (review_id, place_id)
);
CREATE INDEX idx_reviews_place ON reviews(place_id);

-- Append-only archive (off read path)
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_snapshots_place ON snapshots(place_id);

-- Full-text search over place text fields
CREATE VIRTUAL TABLE places_fts USING fts5(
  place_id UNINDEXED,
  name,
  city,
  description,
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE reviews_fts USING fts5(
  place_id UNINDEXED,
  review_id UNINDEXED,
  comment,
  tokenize='porter unicode61'
);

-- Crawler job queue
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
CREATE INDEX idx_jobs_pending_kind ON jobs(status, kind, created_at);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT
);

CREATE TABLE discovery_cells (
  id TEXT NOT NULL,
  pass_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  places_found INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pass_id, id)
);
CREATE INDEX idx_discovery_pass_status ON discovery_cells(pass_id, status);

-- Tile bake tracking
CREATE TABLE tile_manifest (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0,
  built_at TEXT,
  place_count INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  bytes INTEGER NOT NULL DEFAULT 0
);

INSERT INTO tile_manifest (id, version, built_at, place_count, r2_key, bytes)
VALUES (1, 0, NULL, 0, NULL, 0);
