-- Slim storage: drop snapshot archive, reviews without payload_json

DROP TABLE IF EXISTS snapshots;

CREATE TABLE reviews_new (
  review_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  rating REAL,
  author TEXT,
  created_at TEXT,
  comment TEXT NOT NULL DEFAULT '',
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (review_id, place_id)
);

INSERT INTO reviews_new (review_id, place_id, rating, author, created_at, comment, scraped_at)
SELECT review_id, place_id, rating, author, created_at, COALESCE(comment, ''), scraped_at
FROM reviews;

DROP TABLE reviews;

ALTER TABLE reviews_new RENAME TO reviews;

CREATE INDEX IF NOT EXISTS idx_reviews_place ON reviews(place_id);
