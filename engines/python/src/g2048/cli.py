"""``g2048`` command line: validate, bench, play, serve."""

from __future__ import annotations

import argparse
import json
import sys


def _depth_arg(s: str):
    if s == "auto":
        return "auto"
    try:
        v = int(s)
    except ValueError:
        raise argparse.ArgumentTypeError("depth must be 'auto' or an integer") from None
    if v < 1:
        raise argparse.ArgumentTypeError("depth must be >= 1")
    return v


def _agent_config(args) -> dict:
    cfg: dict = {}
    if getattr(args, "depth", None) is not None:
        cfg["depth"] = args.depth
    if getattr(args, "time_budget_ms", None):
        cfg["timeBudgetMs"] = args.time_budget_ms
    if getattr(args, "config", None):
        cfg.update(json.loads(args.config))
    return cfg


def cmd_validate(args) -> int:
    from .validate import run_all

    res = run_all(args.fixtures, include_slow_benchmarks=args.all_benchmarks)
    if args.json:
        print(json.dumps(res, indent=1))
    else:
        for f in res["failures"]:
            print(f"FAIL [{f['fixture']}] {f['case']}: {f['error']}")
        print(f"python: {res['passed']} passed, {res['failed']} failed")
    return 1 if res["failed"] else 0


def cmd_bench(args) -> int:
    from .bench import load_suite, run_suite

    suite = load_suite(args.suite)

    def on_game(r, i):
        if not args.quiet:
            print(
                f"  seed {r['seed']:>6}  score {r['score']:>7}  max {r['maxTile']:>6}  moves {r['moveCount']:>6}  {r['wallMs']:9.1f} ms",
                file=sys.stderr,
            )

    res = run_suite(suite, on_game=on_game if not args.quiet else None)
    out = json.dumps(res, indent=1)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out + "\n")
    else:
        print(out)
    s = res["summary"]
    dec = f"{s['avgDecisionUs']:.1f}" if s["avgDecisionUs"] is not None else "-"
    print(
        f"{res['suiteId']}: {s['games']} games, {s['totalMoves']} moves, "
        f"{s['movesPerSec']:.0f} moves/s, {s['gamesPerSec']:.2f} games/s, {s['nodesPerSec']:.0f} nodes/s, "
        f"avgDecisionUs {dec}, checksum {res['checksum']}",
        file=sys.stderr,
    )
    return 0


def cmd_play(args) -> int:
    from .ai.agents import create_builtin_agent
    from .bench import implementation, play
    from .board import board_to_matrix

    agent = create_builtin_agent(args.agent, _agent_config(args) if args.agent == "expectimax" else None)
    timing: list = []
    game, nodes, wall = play(agent, args.seed, args.max_moves, lambda us, n: timing.append(us))
    snap = game.snapshot()
    if args.json:
        impl = implementation()
        replay = {
            "specVersion": 1,
            "seed": game.seed,
            "moves": game.moves,
            "final": snap,
            "timing": timing,
            "agent": {
                "id": agent.descriptor["id"],
                "name": agent.descriptor["name"],
                "version": agent.descriptor["version"],
                "config": agent.descriptor.get("config", {}),
            },
            "runtime": {"language": "python", "runtime": impl["runtime"], "version": impl["runtimeVersion"], "platform": impl["platform"]},
        }
        print(json.dumps(replay))
        return 0
    for row in board_to_matrix(game.board):
        print(" ".join(f"{v:>6}" if v else "     ." for v in row))
    print(
        f"seed {game.seed}  score {snap['score']}  maxTile {snap['maxTile']}  moves {snap['moveCount']}  "
        f"over {snap['over']}  historyHash {snap['historyHash']}  nodes {nodes}  {wall:.1f} ms"
    )
    if args.moves:
        print(game.moves)
    return 0


def cmd_serve(args) -> int:
    from .server import serve

    cfg = _agent_config(args) if args.agent == "expectimax" else None
    serve(args.host, args.port, args.agent, cfg, verbose=args.verbose)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="g2048", description="Deterministic 2048 engine + canonical expectimax (Python port)")
    sub = p.add_subparsers(dest="command", required=True)

    v = sub.add_parser("validate", help="run every conformance fixture")
    v.add_argument("--fixtures", help="fixtures directory (default: the repo's spec/fixtures)")
    v.add_argument("--json", action="store_true", help="machine-readable output")
    v.add_argument("--all-benchmarks", action="store_true", help="also run the expectimax benchmark checks (slow)")
    v.set_defaults(func=cmd_validate)

    b = sub.add_parser("bench", help="run a benchmark suite and emit a BenchmarkResult")
    b.add_argument("--suite", required=True, help="path to spec/benchmarks/<suite>.json")
    b.add_argument("--out", help="write the result JSON here instead of stdout")
    b.add_argument("--quiet", "-q", action="store_true", help="no per-game progress")
    b.set_defaults(func=cmd_bench)

    pl = sub.add_parser("play", help="play one game with a built-in agent")
    pl.add_argument("--seed", type=int, required=True)
    pl.add_argument("--agent", default="expectimax", choices=["random", "greedy", "expectimax"])
    pl.add_argument("--depth", type=_depth_arg, default=None, help="'auto' or a fixed depth")
    pl.add_argument("--time-budget-ms", type=float, default=None)
    pl.add_argument("--config", help="extra expectimax config as JSON")
    pl.add_argument("--max-moves", type=int, default=0)
    pl.add_argument("--moves", action="store_true", help="print the move string")
    pl.add_argument("--json", action="store_true", help="print a SPEC §8 replay JSON")
    pl.set_defaults(func=cmd_play)

    s = sub.add_parser("serve", help="serve the agent protocol (POST /decide, GET /health)")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8080)
    s.add_argument("--agent", default="expectimax", choices=["random", "greedy", "expectimax"])
    s.add_argument("--depth", type=_depth_arg, default=None, help="'auto' or a fixed depth")
    s.add_argument("--time-budget-ms", type=float, default=None)
    s.add_argument("--config", help="extra expectimax config as JSON")
    s.add_argument("--verbose", action="store_true")
    s.set_defaults(func=cmd_serve)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
