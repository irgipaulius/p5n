"""CLI entrypoints."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import typer

from p5n.db import Database
from p5n.worker import run_worker

app = typer.Typer(add_completion=False, no_args_is_help=True, help="p5n park4night crawler")

DEFAULT_DB = Path("data/p5n.sqlite")
# Albania agri-camping sample area from earlier probe
DEFAULT_LAT = 41.688908
DEFAULT_LNG = 19.641004


def _db(path: Path) -> Database:
    db = Database(path)
    db.init()
    return db


@app.command()
def init(
    db_path: Path = typer.Option(DEFAULT_DB, "--db"),
    max_places: int = typer.Option(50, "--max-places"),
) -> None:
    """Create SQLite schema."""
    db = Database(db_path)
    db.init(max_places=max_places)
    typer.echo(f"initialized {db_path} (max_places={max_places})")


@app.command()
def crawl(
    db_path: Path = typer.Option(DEFAULT_DB, "--db"),
    lat: float = typer.Option(DEFAULT_LAT, "--lat"),
    lng: float = typer.Option(DEFAULT_LNG, "--lng"),
    max_places: int = typer.Option(50, "--max-places", help="Hard cap on known places"),
) -> None:
    """Run crawler until queue drains or place cap is hit."""
    run_worker(db_path, lat=lat, lng=lng, max_places=max_places)


@app.command()
def stats(db_path: Path = typer.Option(DEFAULT_DB, "--db")) -> None:
    """Print crawl statistics."""
    db = _db(db_path)
    typer.echo(json.dumps(db.stats(), indent=2, default=str))


@app.command("show-places")
def show_places(
    db_path: Path = typer.Option(DEFAULT_DB, "--db"),
    limit: int = typer.Option(50, "--limit"),
) -> None:
    """List latest place snapshots."""
    db = _db(db_path)
    places = db.list_places(limit=limit)
    typer.echo(json.dumps(places, indent=2, ensure_ascii=False, default=str))


@app.command()
def pause(db_path: Path = typer.Option(DEFAULT_DB, "--db")) -> None:
    _db(db_path).set_paused(True)
    typer.echo("paused")


@app.command()
def resume(db_path: Path = typer.Option(DEFAULT_DB, "--db")) -> None:
    _db(db_path).set_paused(False)
    typer.echo("resumed")


@app.command()
def rescrape(
    place_id: str = typer.Argument(...),
    db_path: Path = typer.Option(DEFAULT_DB, "--db"),
    lat: Optional[float] = typer.Option(None, "--lat"),
    lng: Optional[float] = typer.Option(None, "--lng"),
) -> None:
    """Enqueue a rescrape job for a place."""
    db = _db(db_path)
    payload: dict = {"place_id": place_id}
    if lat is not None and lng is not None:
        payload["lat"] = lat
        payload["lng"] = lng
    jid = db.enqueue_job("rescrape_place", payload, job_id=f"rescrape:{place_id}:{db.stats()['place_snapshots']}")
    db.emit(f"enqueued rescrape {place_id}", meta={"job_id": jid})
    typer.echo(jid)


@app.command()
def serve(
    db_path: Path = typer.Option(DEFAULT_DB, "--db"),
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8080, "--port"),
) -> None:
    """Run monitoring dashboard."""
    import os

    import uvicorn

    os.environ["P5N_DB"] = str(db_path.resolve())
    uvicorn.run("p5n.serve:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    app()
