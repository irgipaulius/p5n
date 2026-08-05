"""SQLite persistence: append-only snapshots + durable job leases."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import zstandard as zstd

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS crawler_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  max_places INTEGER NOT NULL DEFAULT 50,
  places_crawled INTEGER NOT NULL DEFAULT 0,
  request_delay_ms INTEGER NOT NULL DEFAULT 400,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  body_zstd BLOB NOT NULL,
  bytes_raw INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS places_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  raw_id INTEGER REFERENCES raw_responses(id),
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
CREATE INDEX IF NOT EXISTS idx_places_place_id ON places_snapshots(place_id);
CREATE INDEX IF NOT EXISTS idx_places_scraped ON places_snapshots(scraped_at);

CREATE TABLE IF NOT EXISTS reviews_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  raw_id INTEGER REFERENCES raw_responses(id),
  rating REAL,
  author TEXT,
  created_at TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_place ON reviews_snapshots(place_id);
CREATE INDEX IF NOT EXISTS idx_reviews_review ON reviews_snapshots(review_id);

CREATE TABLE IF NOT EXISTS jobs (
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
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, lease_until);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS known_places (
  place_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  reviews_fetched INTEGER NOT NULL DEFAULT 0
);
"""


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._cctx = zstd.ZstdCompressor(level=3)
        self._dctx = zstd.ZstdDecompressor()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=60)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init(self, max_places: int = 50) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            row = conn.execute("SELECT id FROM crawler_state WHERE id = 1").fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO crawler_state (id, paused, max_places, places_crawled, request_delay_ms, updated_at) "
                    "VALUES (1, 0, ?, 0, 400, ?)",
                    (max_places, utc_now()),
                )
            else:
                conn.execute(
                    "UPDATE crawler_state SET max_places = ?, updated_at = ? WHERE id = 1",
                    (max_places, utc_now()),
                )

    def emit(self, message: str, level: str = "info", meta: dict[str, Any] | None = None) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO run_events (created_at, level, message, meta_json) VALUES (?, ?, ?, ?)",
                (utc_now(), level, message, json.dumps(meta) if meta else None),
            )

    def get_state(self) -> sqlite3.Row:
        with self.connect() as conn:
            return conn.execute("SELECT * FROM crawler_state WHERE id = 1").fetchone()

    def set_paused(self, paused: bool) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE crawler_state SET paused = ?, updated_at = ? WHERE id = 1",
                (1 if paused else 0, utc_now()),
            )

    def set_delay_ms(self, delay_ms: int) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE crawler_state SET request_delay_ms = ?, updated_at = ? WHERE id = 1",
                (delay_ms, utc_now()),
            )

    def reclaim_stale_leases(self) -> int:
        now = time.time()
        with self.connect() as conn:
            cur = conn.execute(
                "UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_until = NULL, "
                "updated_at = ? WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)",
                (utc_now(), now),
            )
            return cur.rowcount

    def enqueue_job(self, kind: str, payload: dict[str, Any], job_id: str | None = None) -> str:
        jid = job_id or str(uuid.uuid4())
        now = utc_now()
        with self.connect() as conn:
            existing = conn.execute("SELECT id FROM jobs WHERE id = ?", (jid,)).fetchone()
            if existing:
                return jid
            conn.execute(
                "INSERT INTO jobs (id, kind, payload_json, status, attempts, created_at, updated_at) "
                "VALUES (?, ?, ?, 'pending', 0, ?, ?)",
                (jid, kind, json.dumps(payload), now, now),
            )
        return jid

    def claim_job(self, owner: str, lease_seconds: float = 120.0) -> sqlite3.Row | None:
        now = time.time()
        with self.connect() as conn:
            state = conn.execute("SELECT paused FROM crawler_state WHERE id = 1").fetchone()
            if state and state["paused"]:
                return None
            row = conn.execute(
                "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                "UPDATE jobs SET status = 'running', lease_owner = ?, lease_until = ?, "
                "attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
                (owner, now + lease_seconds, utc_now(), row["id"]),
            )
            claimed = conn.execute(
                "SELECT * FROM jobs WHERE id = ? AND lease_owner = ? AND status = 'running'",
                (row["id"], owner),
            ).fetchone()
            return claimed

    def heartbeat(self, job_id: str, owner: str, lease_seconds: float = 120.0) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE jobs SET lease_until = ?, updated_at = ? "
                "WHERE id = ? AND lease_owner = ? AND status = 'running'",
                (time.time() + lease_seconds, utc_now(), job_id, owner),
            )

    def finish_job(self, job_id: str, owner: str, error: str | None = None) -> None:
        status = "error" if error else "done"
        with self.connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = ?, last_error = ?, lease_owner = NULL, lease_until = NULL, "
                "updated_at = ? WHERE id = ? AND lease_owner = ?",
                (status, error, utc_now(), job_id, owner),
            )

    def store_raw(self, conn: sqlite3.Connection, url: str, status: int, body: bytes) -> int:
        import hashlib

        sha = hashlib.sha256(body).hexdigest()
        compressed = self._cctx.compress(body)
        cur = conn.execute(
            "INSERT INTO raw_responses (url, fetched_at, http_status, content_sha256, body_zstd, bytes_raw) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (url, utc_now(), status, sha, compressed, len(body)),
        )
        return int(cur.lastrowid)

    def decode_raw(self, body_zstd: bytes) -> bytes:
        return self._dctx.decompress(body_zstd)

    def places_crawled_count(self, conn: sqlite3.Connection | None = None) -> int:
        def _count(c: sqlite3.Connection) -> int:
            row = c.execute("SELECT COUNT(*) AS n FROM known_places").fetchone()
            return int(row["n"])

        if conn is not None:
            return _count(conn)
        with self.connect() as c:
            return _count(c)

    def under_place_cap(self, conn: sqlite3.Connection) -> bool:
        state = conn.execute("SELECT max_places FROM crawler_state WHERE id = 1").fetchone()
        cap = int(state["max_places"])
        return self.places_crawled_count(conn) < cap

    def ingest_places_from_filter(
        self,
        url: str,
        status: int,
        body: bytes,
        places: list[dict[str, Any]],
    ) -> tuple[int, list[str]]:
        """Append place snapshots; return (new_place_count, place_ids_needing_reviews)."""
        new_ids: list[str] = []
        need_reviews: list[str] = []
        with self.connect() as conn:
            raw_id = self.store_raw(conn, url, status, body)
            scraped_at = utc_now()
            state = conn.execute("SELECT max_places FROM crawler_state WHERE id = 1").fetchone()
            cap = int(state["max_places"])

            for place in places:
                place_id = str(place["id"])
                existing = conn.execute(
                    "SELECT place_id, reviews_fetched FROM known_places WHERE place_id = ?",
                    (place_id,),
                ).fetchone()
                is_new = existing is None
                if is_new and self.places_crawled_count(conn) >= cap:
                    continue

                conn.execute(
                    "INSERT INTO places_snapshots "
                    "(place_id, scraped_at, raw_id, lat, lng, name, code, country, city, rating, review_count, payload_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        place_id,
                        scraped_at,
                        raw_id,
                        float(place["latitude"]) if place.get("latitude") else None,
                        float(place["longitude"]) if place.get("longitude") else None,
                        place.get("name") or place.get("titre"),
                        place.get("code"),
                        place.get("pays"),
                        place.get("ville"),
                        float(place["note_moyenne"]) if place.get("note_moyenne") else None,
                        int(place["nb_commentaires"]) if place.get("nb_commentaires") else 0,
                        json.dumps(place, ensure_ascii=False),
                    ),
                )
                if is_new:
                    conn.execute(
                        "INSERT INTO known_places (place_id, first_seen_at, last_seen_at, reviews_fetched) "
                        "VALUES (?, ?, ?, 0)",
                        (place_id, scraped_at, scraped_at),
                    )
                    new_ids.append(place_id)
                    reviews_fetched = 0
                else:
                    conn.execute(
                        "UPDATE known_places SET last_seen_at = ? WHERE place_id = ?",
                        (scraped_at, place_id),
                    )
                    reviews_fetched = int(existing["reviews_fetched"])

                nb = int(place.get("nb_commentaires") or 0)
                if nb > 0 and reviews_fetched == 0:
                    need_reviews.append(place_id)

            count = self.places_crawled_count(conn)
            conn.execute(
                "UPDATE crawler_state SET places_crawled = ?, updated_at = ? WHERE id = 1",
                (count, scraped_at),
            )
        return len(new_ids), need_reviews

    def ingest_reviews(
        self,
        place_id: str,
        url: str,
        status: int,
        body: bytes,
        comments: list[dict[str, Any]],
    ) -> int:
        with self.connect() as conn:
            raw_id = self.store_raw(conn, url, status, body)
            scraped_at = utc_now()
            for c in comments:
                conn.execute(
                    "INSERT INTO reviews_snapshots "
                    "(review_id, place_id, scraped_at, raw_id, rating, author, created_at, payload_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(c["id"]),
                        place_id,
                        scraped_at,
                        raw_id,
                        float(c["note"]) if c.get("note") else None,
                        c.get("uuid"),
                        c.get("date_creation"),
                        json.dumps(c, ensure_ascii=False),
                    ),
                )
            conn.execute(
                "UPDATE known_places SET reviews_fetched = 1, last_seen_at = ? WHERE place_id = ?",
                (scraped_at, place_id),
            )
        return len(comments)

    def stats(self) -> dict[str, Any]:
        with self.connect() as conn:
            state = dict(conn.execute("SELECT * FROM crawler_state WHERE id = 1").fetchone())
            jobs = {
                r["status"]: r["n"]
                for r in conn.execute(
                    "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
                ).fetchall()
            }
            places = conn.execute("SELECT COUNT(*) AS n FROM known_places").fetchone()["n"]
            snapshots = conn.execute("SELECT COUNT(*) AS n FROM places_snapshots").fetchone()["n"]
            reviews = conn.execute("SELECT COUNT(*) AS n FROM reviews_snapshots").fetchone()["n"]
            raw_bytes = conn.execute(
                "SELECT COALESCE(SUM(bytes_raw), 0) AS n FROM raw_responses"
            ).fetchone()["n"]
            return {
                "state": state,
                "jobs": jobs,
                "known_places": places,
                "place_snapshots": snapshots,
                "review_snapshots": reviews,
                "raw_bytes": raw_bytes,
            }

    def list_places(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT p.place_id, p.name, p.lat, p.lng, p.country, p.city, p.rating,
                       p.review_count, p.scraped_at, k.reviews_fetched
                FROM places_snapshots p
                JOIN (
                  SELECT place_id, MAX(id) AS max_id FROM places_snapshots GROUP BY place_id
                ) latest ON p.id = latest.max_id
                JOIN known_places k ON k.place_id = p.place_id
                ORDER BY p.place_id
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def recent_events(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM run_events ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]
