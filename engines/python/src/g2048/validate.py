"""Run every conformance fixture in spec/fixtures and report failures."""

from __future__ import annotations

import json
import os
from pathlib import Path

from .ai import bitboard as bb
from .ai.agents import GameMeta, Observation, RandomAgent
from .ai.expectimax import ExpectimaxSearch
from .ai.heuristic import evaluate, line_features, line_table
from .board import DIRECTION_LETTERS, board_from_hex, board_to_hex, is_over, move, spawn
from .game import Game
from .hashing import board_hash, hash_hex, history_step
from .ids import format_replay_code, normalize_replay_code
from .replay import ReplayError, simulate
from .rng import Rng, mix32

FIXTURE_FILES = ("rng", "moves", "spawn", "hash", "games", "replays", "codes", "ai", "benchmarks")


def default_fixtures_dir() -> Path:
    """Locate the repo's spec/fixtures relative to this package (engines/python/src/g2048)."""
    env = os.environ.get("G2048_FIXTURES")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "spec" / "fixtures"
        if cand.is_dir():
            return cand
    return here.parents[4] / "spec" / "fixtures"


def default_spec_dir() -> Path:
    return default_fixtures_dir().parent


def load_fixture(name: str, fixtures_dir=None) -> dict:
    d = Path(fixtures_dir) if fixtures_dir else default_fixtures_dir()
    with open(d / f"{name}.json", encoding="utf-8") as f:
        return json.load(f)


def values_close(actual, expected, rel: float = 1e-9) -> bool:
    if len(actual) != len(expected):
        return False
    for a, e in zip(actual, expected):
        if e is None or a is None:
            if a is not e:
                return False
        elif abs(a - e) > rel * max(abs(e), 1e-300):
            return False
    return True


def play_random(seed: int, max_moves: int = 0) -> Game:
    """Play the SPEC §10 random agent to completion (or ``max_moves``)."""
    game = Game(seed)
    agent = RandomAgent()
    agent.reset(GameMeta(game.seed))
    limit = max_moves if max_moves > 0 else float("inf")
    while game.move_count < limit and not game.over:
        d = agent.decide(Observation(game.board, game.score, game.move_count))
        if game.apply(d.move) is None:
            raise AssertionError(f"random agent chose invalid move {d.move}")
    return game


# ------------------------------------------------------------------ per-file checks
# Each check yields (case_name, error_message_or_None).


def check_rng(fx):
    for c in fx["cases"]:
        seed = c["seed"]
        if mix32(seed) != c["state"]:
            yield f"rng seed={seed} state", f"got {mix32(seed)}"
            continue
        r = Rng.from_seed(seed)
        got = [r.next() for _ in range(len(c["next"]))]
        yield f"rng seed={seed} next", None if got == c["next"] else f"got {got}"
        for n, seq in c["below"].items():
            r = Rng.from_seed(seed)
            got = [r.below(int(n)) for _ in range(len(seq))]
            yield f"rng seed={seed} below({n})", None if got == seq else f"got {got}"


def check_moves(fx):
    for c in fx["cases"]:
        b = board_from_hex(c["board"])
        for res in c["results"]:
            d = DIRECTION_LETTERS.index(res["dir"])
            nb, gained, changed = move(b, d)
            ok = board_to_hex(nb) == res["board"] and gained == res["gained"] and changed == res["changed"]
            yield (
                f"move {c['board']} {res['dir']}",
                None if ok else f"got board={board_to_hex(nb)} gained={gained} changed={changed}",
            )
        if "over" in c:
            yield f"over {c['board']}", None if is_over(b) == c["over"] else f"got {is_over(b)}"


def check_spawn(fx):
    for c in fx["cases"]:
        b = board_from_hex(c["board"])
        r = Rng(c["rngState"])
        s = spawn(b, r)
        exp = c["spawn"]
        got = None if s is None else {"index": s[0], "exponent": s[1]}
        ok = board_to_hex(b) == c["result"] and r.state() == c["rngStateAfter"] and got == exp
        yield f"spawn {c['board']}", None if ok else f"got board={board_to_hex(b)} state={r.state()} spawn={got}"


def check_hash(fx):
    for c in fx["cases"]:
        b = board_from_hex(c["board"])
        bh = hash_hex(board_hash(b))
        hs = hash_hex(history_step(int(c["prev"], 16), b, c["dir"]))
        ok = bh == c["boardHash"] and hs == c["historyStep"]
        yield f"hash {c['board']}", None if ok else f"got boardHash={bh} historyStep={hs}"


def check_games(fx):
    for c in fx["newGames"]:
        g = Game(c["seed"])
        ok = board_to_hex(g.board) == c["board"] and g.rng_state() == c["rngState"] and g.history_hash == c["historyHash"]
        yield (
            f"newGame seed={c['seed']}",
            None if ok else f"got board={board_to_hex(g.board)} rng={g.rng_state()} hash={g.history_hash}",
        )
    for c in fx["games"]:
        name = f"game seed={c['seed']} agent={c['agent']}"
        try:
            snap = simulate(c["seed"], c["moves"]).snapshot()
        except ReplayError as e:
            yield name, f"replay error {e.code} at {e.move_index}"
            continue
        if snap != c["final"]:
            yield name, f"final mismatch: got {snap}"
            continue
        if c["agent"] == "random":
            g = play_random(c["seed"])
            if g.moves != c["moves"]:
                yield name + " (agent)", "random agent produced a different move sequence"
                continue
        yield name, None


def check_replays(fx):
    for c in fx["cases"]:
        exp = c["expect"]
        name = f"replay {c['name']}"
        try:
            snap = simulate(c["seed"], c["moves"]).snapshot()
        except ReplayError as e:
            if exp["ok"]:
                yield name, f"unexpected error {e.code} at {e.move_index}"
            elif e.code != exp["error"] or e.move_index != exp.get("moveIndex"):
                yield name, f"got error {e.code} at {e.move_index}"
            else:
                yield name, None
            continue
        if not exp["ok"]:
            yield name, f"expected error {exp['error']}, got success"
        elif snap != exp["final"]:
            yield name, f"final mismatch: got {snap}"
        else:
            yield name, None


def check_codes(fx):
    for c in fx["cases"]:
        n = normalize_replay_code(c["input"])
        f = format_replay_code(n) if n is not None else None
        ok = n == c["normalized"] and f == c["formatted"]
        yield f"code {c['input']!r}", None if ok else f"got normalized={n} formatted={f}"


def check_ai(fx, include_slow: bool = True):
    wc = fx["weights"]["canonical"]
    wa = fx["weights"]["allWeights"]
    tc = line_table(wc)
    ta = line_table(wa)
    for c in fx["lines"]:
        v = c["line"]
        f = line_features(v)
        ok = f == c["features"] and tc[v] == c["canonical"] and ta[v] == c["allWeights"]
        yield f"ai line {v}", None if ok else f"got features={f} canonical={tc[v]} allWeights={ta[v]}"
    for c in fx["evaluations"]:
        b = bb.from_hex(c["board"])
        ec = evaluate(b, tc, wc["corner"])
        ea = evaluate(b, ta, wa["corner"])
        ok = ec == c["canonical"] and ea == c["allWeights"]
        yield f"ai eval {c['board']}", None if ok else f"got canonical={ec} allWeights={ea}"
    for c in fx["bitboardMoves"]:
        b = bb.from_hex(c["board"])
        ms = bb.moves4(b)
        got = [{"changed": m != b, "board": bb.to_hex(m)} for m in ms]
        yield f"ai bbmove {c['board']}", None if got == c["results"] else f"got {got}"
    for c in fx["searches"]:
        if not include_slow and (c["profile"] == "canonical" or c["config"].get("depth", 0) >= 3):
            continue
        s = ExpectimaxSearch(c["config"])
        r = s.search(bb.from_hex(c["board"]))
        mv = None if r.move is None else DIRECTION_LETTERS[r.move]
        ok = mv == c["move"] and r.depth == c["depth"] and values_close(r.values, c["values"])
        yield (
            f"ai search {c['profile']} {c['board']}",
            None if ok else f"got move={mv} depth={r.depth} values={r.values}",
        )


def check_benchmarks(fx, spec_dir=None, include_slow: bool = False):
    from .bench import load_suite, run_suite

    bench_dir = Path(spec_dir) / "benchmarks" if spec_dir else default_spec_dir() / "benchmarks"
    for suite_id, exp in fx["suites"].items():
        slow = suite_id != "engine-random-1k"
        if slow and not include_slow:
            continue
        res = run_suite(load_suite(bench_dir / f"{suite_id}.json"))
        got = {
            "checksum": res["checksum"],
            "games": res["summary"]["games"],
            "totalMoves": res["summary"]["totalMoves"],
            "totalScore": sum(g["score"] for g in res["games"]),
            "maxScore": res["summary"]["maxScore"],
        }
        yield f"benchmark {suite_id}", None if got == exp else f"got {got}"


CHECKS = {
    "rng": check_rng,
    "moves": check_moves,
    "spawn": check_spawn,
    "hash": check_hash,
    "games": check_games,
    "replays": check_replays,
    "codes": check_codes,
    "ai": check_ai,
    "benchmarks": check_benchmarks,
}


def run_all(fixtures_dir=None, include_slow_benchmarks: bool = False) -> dict:
    fdir = Path(fixtures_dir) if fixtures_dir else default_fixtures_dir()
    passed = 0
    failures = []
    for name in FIXTURE_FILES:
        try:
            fx = load_fixture(name, fdir)
        except FileNotFoundError:
            failures.append({"fixture": name, "case": "load", "error": f"missing {fdir / (name + '.json')}"})
            continue
        if name == "benchmarks":
            it = check_benchmarks(fx, fdir.parent, include_slow_benchmarks)
        else:
            it = CHECKS[name](fx)
        try:
            for case, err in it:
                if err is None:
                    passed += 1
                else:
                    failures.append({"fixture": name, "case": case, "error": err})
        except Exception as e:  # a crash in one fixture file shouldn't hide the others
            failures.append({"fixture": name, "case": "exception", "error": f"{type(e).__name__}: {e}"})
    return {"language": "python", "passed": passed, "failed": len(failures), "failures": failures}
