"""Durable job worker — crash-safe via leases."""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from p5n.db import Database
from p5n.http import ParkClient
from p5n.sources import fetch_comments, fetch_filter


def run_worker(
    db_path: Path,
    *,
    lat: float,
    lng: float,
    max_places: int = 50,
    once: bool = False,
    owner: str | None = None,
) -> None:
    db = Database(db_path)
    db.init(max_places=max_places)
    worker_id = owner or f"worker-{uuid.uuid4().hex[:8]}"

    reclaimed = db.reclaim_stale_leases()
    if reclaimed:
        db.emit(f"reclaimed {reclaimed} stale job lease(s)", meta={"reclaimed": reclaimed})

    # Seed discovery job if none pending/running and we have no places yet
    stats = db.stats()
    pendingish = stats["jobs"].get("pending", 0) + stats["jobs"].get("running", 0)
    if pendingish == 0 and stats["known_places"] == 0:
        jid = f"filter:{lat:.5f}:{lng:.5f}"
        db.enqueue_job("filter_cell", {"lat": lat, "lng": lng}, job_id=jid)
        db.emit(f"enqueued filter cell {lat},{lng}", meta={"job_id": jid})

    db.emit(f"worker {worker_id} started", meta={"max_places": max_places})

    with ParkClient() as client:
        idle_rounds = 0
        while True:
            state = db.get_state()
            if state["paused"]:
                time.sleep(1.0)
                if once:
                    break
                continue

            job = db.claim_job(worker_id)
            if job is None:
                idle_rounds += 1
                # Cap reached and no jobs → done
                if db.places_crawled_count() >= int(state["max_places"]):
                    # Still drain review jobs if any pending was missed — check again
                    db.emit(
                        f"place cap reached ({state['max_places']}); waiting for remaining jobs",
                        level="info",
                    )
                if idle_rounds >= 3:
                    # ensure no pending
                    s = db.stats()
                    if s["jobs"].get("pending", 0) == 0 and s["jobs"].get("running", 0) == 0:
                        db.emit("queue empty — worker stopping")
                        break
                time.sleep(0.5)
                if once and idle_rounds >= 1:
                    break
                continue

            idle_rounds = 0
            delay_ms = int(state["request_delay_ms"])
            try:
                _handle_job(db, client, job, worker_id)
                db.finish_job(job["id"], worker_id)
            except Exception as exc:  # noqa: BLE001 — surface to job error
                db.finish_job(job["id"], worker_id, error=str(exc))
                db.emit(f"job {job['id']} failed: {exc}", level="error")
            time.sleep(delay_ms / 1000.0)


def _handle_job(db: Database, client: ParkClient, job, worker_id: str) -> None:
    payload = json.loads(job["payload_json"])
    kind = job["kind"]
    db.heartbeat(job["id"], worker_id)

    if kind == "filter_cell":
        lat = float(payload["lat"])
        lng = float(payload["lng"])
        url, status, body, places = fetch_filter(client, lat, lng)
        # Enforce max places: truncate list of brand-new candidates in ingest
        new_count, need_reviews = db.ingest_places_from_filter(url, status, body, places)
        state = db.get_state()
        cap = int(state["max_places"])
        known = db.places_crawled_count()
        db.emit(
            f"filter {lat},{lng}: got {len(places)} places, +{new_count} new (known={known}/{cap})",
            meta={"url": url, "http_status": status, "bytes": len(body)},
        )
        # Only enqueue reviews for places we kept, up to remaining budget interest
        for place_id in need_reviews:
            db.enqueue_job(
                "place_reviews",
                {"place_id": place_id},
                job_id=f"reviews:{place_id}",
            )
        return

    if kind == "place_reviews":
        place_id = str(payload["place_id"])
        url, status, body, comments = fetch_comments(client, place_id)
        n = db.ingest_reviews(place_id, url, status, body, comments)
        db.emit(
            f"reviews place {place_id}: {n} comments",
            meta={"url": url, "http_status": status, "bytes": len(body)},
        )
        return

    if kind == "rescrape_place":
        # Re-fetch filter around place coords if provided, else reviews only
        place_id = str(payload["place_id"])
        if "lat" in payload and "lng" in payload:
            url, status, body, places = fetch_filter(
                client, float(payload["lat"]), float(payload["lng"])
            )
            db.ingest_places_from_filter(url, status, body, places)
        url, status, body, comments = fetch_comments(client, place_id)
        n = db.ingest_reviews(place_id, url, status, body, comments)
        db.emit(f"rescrape place {place_id}: {n} comments")
        return

    raise RuntimeError(f"unknown job kind: {kind}")
