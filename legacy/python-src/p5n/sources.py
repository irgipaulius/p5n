"""park4night guest API endpoints."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from p5n.http import ParkClient

GUEST = "https://guest.park4night.com/services/V4.1"


def filter_url(lat: float, lng: float) -> str:
    qs = urlencode({"latitude": f"{lat:.6f}", "longitude": f"{lng:.6f}"})
    return f"{GUEST}/lieuxGetFilter.php?{qs}"


def comments_url(place_id: str) -> str:
    qs = urlencode({"lieu_id": place_id})
    return f"{GUEST}/commGet.php?{qs}"


def fetch_filter(client: ParkClient, lat: float, lng: float) -> tuple[str, int, bytes, list[dict[str, Any]]]:
    url = filter_url(lat, lng)
    status, body, data = client.get_json(url)
    if data.get("status") != "OK":
        raise RuntimeError(f"filter status not OK: {data!r}")
    places = data.get("lieux") or []
    return url, status, body, places


def fetch_comments(
    client: ParkClient, place_id: str
) -> tuple[str, int, bytes, list[dict[str, Any]]]:
    url = comments_url(place_id)
    status, body, data = client.get_json(url)
    if data.get("status") != "OK":
        raise RuntimeError(f"commGet status not OK: {data!r}")
    comments = data.get("commentaires") or []
    return url, status, body, comments
