"""
Platform API client (standard library only).

External Python agents use this to play entirely through the public API —
no browser, no scraping::

    from g2048.client import PlatformClient

    api = PlatformClient("https://2048api.ifsvivek.in", api_key=None)
    state = api.create_game(seed=42)
    while state["status"] == "active":
        state = api.move(state["gameId"], choose(state))   # full state every time
    print(state["score"], api.replay(state["replayCode"])["moves"])
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Iterable


class PlatformError(Exception):
    """A machine-readable API error: ``code`` is e.g. GAME_NOT_FOUND, INVALID_MOVE."""

    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.details = details or {}


class PlatformClient:
    def __init__(self, base_url: str, api_key: str | None = None, timeout: float = 15.0, retries: int = 3):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.retries = retries

    # ------------------------------------------------------------------ core
    def request(self, method: str, path: str, body: Any = None, auth: bool = False) -> Any:
        data = None if body is None else json.dumps(body).encode()
        headers = {"accept": "application/json", "user-agent": "g2048-python-client/1"}
        if data is not None:
            headers["content-type"] = "application/json"
        if auth and self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    raw = res.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                payload = json.loads(e.read() or b"{}")
                # Rate limits are transient: back off and retry.
                if e.code == 429 and attempt < self.retries:
                    time.sleep(2 ** attempt)
                    continue
                raise PlatformError(e.code, payload.get("code", f"HTTP_{e.code}"), payload.get("message", ""), payload.get("details")) from None
            except urllib.error.URLError:
                if attempt < self.retries:
                    time.sleep(2 ** attempt)
                    continue
                raise
        raise RuntimeError("unreachable")

    # ----------------------------------------------------------------- games
    def create_game(self, seed: int | None = None, agent_name: str | None = None, config: dict | None = None, runtime: dict | None = None) -> dict:
        body: dict[str, Any] = {"source": "api"}
        if seed is not None:
            body["seed"] = seed
        if agent_name or config:
            body["agent"] = {"name": agent_name or "python-agent", "config": config or {}}
        if runtime:
            body["runtime"] = runtime
        return self.request("POST", "/v1/games", body, auth=True)

    def get_game(self, game_id: str) -> dict:
        return self.request("GET", f"/v1/games/{game_id}")

    def move(self, game_id: str, move: str, time_us: int | None = None, metrics: dict | None = None) -> dict:
        body: dict[str, Any] = {"move": move}
        if time_us is not None:
            body["timing"] = [int(time_us)]
        if metrics:
            body["metrics"] = metrics
        return self.request("POST", f"/v1/games/{game_id}/moves", body)

    def moves(self, game_id: str, moves: Iterable[str], timing: list[int] | None = None) -> dict:
        body: dict[str, Any] = {"moves": list(moves)}
        if timing:
            body["timing"] = timing
        return self.request("POST", f"/v1/games/{game_id}/moves", body)

    def resign(self, game_id: str) -> dict:
        return self.request("POST", f"/v1/games/{game_id}/resign")

    def report_usage(self, game_id: str, model: str, input_tokens: int, output_tokens: int, *, provider: str = "other",
                     cache_read_tokens: int = 0, reasoning_tokens: int = 0, calls: int = 0, cost_usd: float | None = None) -> dict:
        """Record an LLM's cumulative token/cost burn for a game (re-reporting replaces)."""
        body: dict[str, Any] = {"model": model, "provider": provider, "inputTokens": input_tokens, "outputTokens": output_tokens,
                                "cacheReadTokens": cache_read_tokens, "reasoningTokens": reasoning_tokens, "calls": calls}
        if cost_usd is not None:
            body["costUsd"] = cost_usd
        return self.request("POST", f"/v1/games/{game_id}/usage", body)

    # --------------------------------------------------------------- replays
    def replay(self, ref: str) -> dict:
        return self.request("GET", f"/v1/replays/{ref}")

    def upload_replay(self, seed: int, moves: str, **fields: Any) -> dict:
        return self.request("POST", "/v1/replays", {"specVersion": 1, "seed": seed, "moves": moves, **fields})

    # ---------------------------------------------------------------- agents
    def register_agent(self, name: str, kind: str = "remote", language: str = "python", endpoint: str | None = None, description: str | None = None) -> dict:
        res = self.request("POST", "/v1/agents", {"name": name, "kind": kind, "language": language, "endpoint": endpoint, "description": description})
        self.api_key = res["apiKey"]
        return res

    def agent_stats(self, ref: str) -> dict:
        return self.request("GET", f"/v1/agents/{ref}")

    # ------------------------------------------------------------ benchmarks
    def submit_benchmark(self, result: dict) -> dict:
        if len(result.get("games", [])) > 1000:  # the API keeps 1,000 compact rows; checksum covers all games
            result = {**result, "games": result["games"][:1000]}
        return self.request("POST", "/v1/benchmarks/runs", result)

    def leaderboard(self, kind: str = "all") -> dict:
        return self.request("GET", f"/v1/leaderboard?kind={kind}")

    def analytics(self, report: str = "overview") -> dict:
        return self.request("GET", f"/v1/analytics/{report}")
