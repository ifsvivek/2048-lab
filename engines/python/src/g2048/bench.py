"""Benchmark-suite runner emitting spec/schemas/benchmark-result.schema.json.

Summary semantics follow the TypeScript reference (packages/engine/src/sim.ts):
median = sorted scores at floor(n/2); percentiles = sorted[min(n-1, floor(p*n))];
checksum = fnv1a32 over the ASCII historyHash strings concatenated in seed order.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import time
from datetime import datetime, timezone

from . import ENGINE_VERSION
from .ai.agents import GameMeta, Observation, create_builtin_agent
from .board import max_tile
from .game import SPEC_VERSION, Game
from .hashing import fnv1a32, hash_hex

REACH_TILES = (2048, 4096, 8192, 16384, 32768, 65536)


def load_suite(path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def implementation() -> dict:
    return {
        "language": "python",
        "runtime": platform.python_implementation().lower(),
        "runtimeVersion": platform.python_version(),
        "engineVersion": ENGINE_VERSION,
        "platform": sys.platform,
    }


def _cpu_model() -> str | None:
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as f:
            for line in f:
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or None


def _memory_bytes() -> int | None:
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    return None


def environment() -> dict:
    env: dict = {
        "os": platform.system().lower(),
        "osRelease": platform.release(),
        "arch": platform.machine(),
        "cpus": os.cpu_count() or 0,
    }
    model = _cpu_model()
    if model:
        env["cpuModel"] = model
    mem = _memory_bytes()
    if mem:
        env["memoryBytes"] = mem
    return env


def peak_memory_bytes() -> int | None:
    try:
        import resource
    except ImportError:  # Windows
        return None
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # ru_maxrss is KiB on Linux, bytes on macOS.
    return int(rss) if sys.platform == "darwin" else int(rss) * 1024


def play(agent, seed: int, max_moves: int = 0, on_decision=None, game_id: str | None = None):
    """Play a synchronous agent; returns ``(game, nodes, wall_ms)``."""
    clock = time.perf_counter
    t0 = clock()
    game = Game(seed)
    meta = GameMeta(game.seed, SPEC_VERSION, game_id)
    agent.reset(meta)
    nodes = 0
    limit = max_moves if max_moves and max_moves > 0 else float("inf")
    decide = agent.decide
    apply = game.apply
    while game.move_count < limit and not game.over:
        d = decide(Observation(game.board, game.score, game.move_count, meta))
        if apply(d.move) is None:
            raise RuntimeError(f"agent {agent.descriptor.get('id')} returned invalid move {d.move} at {game.move_count}")
        m = d.metrics
        n = m.get("nodes") or 0
        nodes += n
        if on_decision is not None:
            on_decision(m.get("timeUs", 0), n)
    return game, nodes, (clock() - t0) * 1000.0


def _percentile(sorted_vals, p: float):
    if not sorted_vals:
        return 0
    return sorted_vals[min(len(sorted_vals) - 1, int(p * len(sorted_vals)))]


def summarise(games: list, wall_ms: float, cpu_ms, peak_memory, decisions) -> dict:
    scores = sorted(g["score"] for g in games)
    n = len(games)
    total_moves = sum(g["moveCount"] for g in games)
    nodes = sum(g["nodes"] for g in games)
    dist: dict = {}
    for g in games:
        dist[g["maxTile"]] = dist.get(g["maxTile"], 0) + 1
    # JS orders integer-like object keys ascending; mirror that.
    tile_distribution = {str(k): dist[k] for k in sorted(dist)}
    reach = {str(t): (sum(1 for g in games if g["maxTile"] >= t) / n if n else 0) for t in REACH_TILES}
    secs = wall_ms / 1000.0
    avg_dec = p50 = p99 = None
    if decisions:
        s = sorted(decisions)
        acc = 0.0
        for x in s:
            acc += x
        avg_dec = acc / len(s)
        p50 = _percentile(s, 0.5)
        p99 = _percentile(s, 0.99)
    return {
        "games": n,
        "avgScore": sum(scores) / n if n else 0,
        "medianScore": scores[n // 2] if n else 0,
        "minScore": scores[0] if n else 0,
        "maxScore": scores[-1] if n else 0,
        "maxTile": max((g["maxTile"] for g in games), default=0),
        "totalMoves": total_moves,
        "wallMs": wall_ms,
        "cpuMs": cpu_ms,
        "gamesPerSec": n / secs if secs > 0 else 0,
        "movesPerSec": total_moves / secs if secs > 0 else 0,
        "decisionsPerSec": total_moves / secs if secs > 0 else 0,
        "nodes": nodes,
        "nodesPerSec": nodes / secs if secs > 0 else 0,
        "peakMemoryBytes": peak_memory,
        "avgDecisionUs": avg_dec,
        "p50DecisionUs": p50,
        "p99DecisionUs": p99,
        "tileDistribution": tile_distribution,
        "reachRates": reach,
    }


def suite_checksum(games: list) -> str:
    return hash_hex(fnv1a32("".join(g["historyHash"] for g in games).encode("ascii")))


def run_suite(suite: dict, on_game=None) -> dict:
    if suite.get("specVersion") != SPEC_VERSION:
        raise ValueError(f"suite {suite.get('id')} targets spec v{suite.get('specVersion')}")
    agent_spec = suite["agent"]
    agent = create_builtin_agent(agent_spec["id"], agent_spec.get("config"))
    started_at = _iso_now()
    cpu0 = time.process_time()
    decisions: list | None = [] if suite.get("timeDecisions") else None
    on_decision = (lambda us, _n: decisions.append(us)) if decisions is not None else None
    max_moves = suite.get("maxMoves", 0) or 0
    games = []
    t0 = time.perf_counter()
    start = suite["seeds"]["start"]
    for i in range(suite["seeds"]["count"]):
        seed = (start + i) & 0xFFFFFFFF
        game, nodes, wall = play(agent, seed, max_moves, on_decision)
        r = {
            "seed": seed,
            "score": game.score,
            "maxTile": max_tile(game.board),
            "moveCount": game.move_count,
            "over": game.over,
            "historyHash": game.history_hash,
            "wallMs": wall,
            "nodes": nodes,
        }
        games.append(r)
        if on_game is not None:
            on_game(r, i)
    wall_ms = (time.perf_counter() - t0) * 1000.0
    cpu_ms = (time.process_time() - cpu0) * 1000.0
    cfg = agent.descriptor.get("config") or {}
    budget = cfg.get("timeBudgetMs")
    deterministic = not (isinstance(budget, (int, float)) and budget > 0)
    agent_out = {"id": agent_spec["id"]}
    if "config" in agent_spec:
        agent_out["config"] = agent_spec["config"]
    return {
        "schemaVersion": 1,
        "suiteId": suite["id"],
        "specVersion": SPEC_VERSION,
        "implementation": implementation(),
        "environment": environment(),
        "agent": agent_out,
        "deterministic": deterministic,
        "startedAt": started_at,
        "finishedAt": _iso_now(),
        "games": games,
        "summary": summarise(games, wall_ms, cpu_ms, peak_memory_bytes(), decisions),
        "checksum": suite_checksum(games),
    }
