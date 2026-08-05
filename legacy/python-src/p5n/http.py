"""HTTP client with polite backoff."""

from __future__ import annotations

import time
from typing import Any

import httpx

DEFAULT_HEADERS = {
    "User-Agent": "p5n/0.1 (research crawler; +https://github.com/irgipaulius/p5n)",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en",
    "Axios-Ajax": "true",
}


class ParkClient:
    def __init__(self, timeout: float = 30.0) -> None:
        self._client = httpx.Client(headers=DEFAULT_HEADERS, timeout=timeout, follow_redirects=True)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ParkClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def get_bytes(self, url: str, max_retries: int = 5) -> tuple[int, bytes]:
        delay = 1.0
        last_exc: Exception | None = None
        for attempt in range(max_retries):
            try:
                resp = self._client.get(url)
                if resp.status_code in (429, 500, 502, 503, 504):
                    time.sleep(delay)
                    delay = min(delay * 2, 30)
                    continue
                return resp.status_code, resp.content
            except httpx.HTTPError as exc:
                last_exc = exc
                time.sleep(delay)
                delay = min(delay * 2, 30)
        raise RuntimeError(f"GET failed after retries: {url}") from last_exc

    def get_json(self, url: str) -> tuple[int, bytes, Any]:
        status, body = self.get_bytes(url)
        import json

        return status, body, json.loads(body.decode("utf-8"))
