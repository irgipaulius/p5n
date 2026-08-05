"""Minimal FastAPI dashboard + control plane."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

from p5n.db import Database

DB_PATH = Path(os.environ.get("P5N_DB", "data/p5n.sqlite"))
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

app = FastAPI(title="p5n")


def get_db() -> Database:
    db = Database(DB_PATH)
    if not DB_PATH.exists():
        db.init()
    return db


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request) -> HTMLResponse:
    db = get_db()
    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "stats": db.stats(),
            "places": db.list_places(limit=50),
            "events": db.recent_events(limit=40),
        },
    )


@app.get("/api/stats")
def api_stats() -> JSONResponse:
    return JSONResponse(get_db().stats())


@app.get("/api/places")
def api_places(limit: int = 50) -> JSONResponse:
    return JSONResponse(get_db().list_places(limit=limit))


@app.get("/api/events")
def api_events(limit: int = 50) -> JSONResponse:
    return JSONResponse(get_db().recent_events(limit=limit))


@app.post("/api/control/pause")
def control_pause() -> JSONResponse:
    db = get_db()
    db.set_paused(True)
    db.emit("paused via dashboard")
    return JSONResponse({"ok": True, "paused": True})


@app.post("/api/control/resume")
def control_resume() -> JSONResponse:
    db = get_db()
    db.set_paused(False)
    db.emit("resumed via dashboard")
    return JSONResponse({"ok": True, "paused": False})


@app.post("/api/control/rescrape/{place_id}")
def control_rescrape(place_id: str) -> JSONResponse:
    db = get_db()
    jid = db.enqueue_job("rescrape_place", {"place_id": place_id})
    db.emit(f"enqueued rescrape {place_id}", meta={"job_id": jid})
    return JSONResponse({"ok": True, "job_id": jid})


@app.get("/api/events/stream")
async def events_stream() -> StreamingResponse:
    async def gen():
        db = get_db()
        last_id = 0
        while True:
            events = db.recent_events(limit=20)
            events = list(reversed(events))
            for ev in events:
                if ev["id"] > last_id:
                    last_id = ev["id"]
                    yield f"data: {json.dumps(ev, default=str)}\n\n"
            stats = db.stats()
            yield f"event: stats\ndata: {json.dumps(stats, default=str)}\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream")
