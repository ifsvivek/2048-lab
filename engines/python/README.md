# g2048 — Python port

A standard-library-only Python implementation of the deterministic 2048 engine
(`spec/SPEC.md`), the canonical expectimax AI (`spec/AI.md`), the benchmark
runner (`spec/schemas/benchmark-result.schema.json`) and the HTTP agent server
(`spec/AGENT_PROTOCOL.md`). It runs on CPython ≥ 3.10 and on PyPy without changes.

```sh
cd engines/python
uv sync                       # creates .venv (the only dev dependency is pytest)
uv run pytest -q              # every fixture in spec/fixtures (+ the benchmark checksums)
uv run pytest -q -m "not slow"   # skip the expectimax benchmark suites
```

## CLI

```sh
uv run g2048 validate [--fixtures PATH] [--json] [--all-benchmarks]
uv run g2048 bench --suite ../../spec/benchmarks/engine-random-1k.json [--out result.json] [-q]
uv run g2048 play --seed 42 [--agent random|greedy|expectimax] [--depth auto|N] [--time-budget-ms N] [--json]
uv run g2048 serve [--host 127.0.0.1] [--port 8080] [--agent expectimax] [--depth auto|N] [--time-budget-ms N]
```

* `validate` exits 1 if any fixture fails; `--json` prints
  `{"language":"python","passed":N,"failed":M,"failures":[...]}`. The default
  fixtures path is the repo's `spec/fixtures` (override with `--fixtures` or
  `G2048_FIXTURES`).
* `bench` writes a `BenchmarkResult` to stdout (or `--out`) and a one-line
  summary to stderr.
* `play --json` prints a SPEC §8 replay.
* `serve` implements `POST /decide` (accepts `boardHex` or the `board` value
  matrix) and `GET /health`, with permissive CORS headers.

To run under PyPy: `uv run --python pypy3 g2048 bench --suite ...`.

## Layout

| Module | Contents |
|---|---|
| `g2048/rng.py` | `mix32`, xoshiro128** `Rng` with `below(n)` |
| `g2048/board.py` | exponent boards, canonical lines per direction, `move(board, dir) -> (board, gained, changed)`, spawn |
| `g2048/game.py` | `Game` (`apply(dir) -> StepResult \| None`, `over`, `history_hash`, `moves`, `snapshot()`) |
| `g2048/hashing.py` | FNV-1a board and history hashes |
| `g2048/replay.py` | `simulate`, `verify`, `ReplayError` (`INVALID_MOVE_AT`, `BAD_LETTER`, `SPEC_VERSION`, `FINAL_MISMATCH`) |
| `g2048/ids.py` | replay codes, ULIDs, random seeds |
| `g2048/ai/` | int bitboard + 65536-entry line tables, heuristic, expectimax, agents |
| `g2048/bench.py` | suite runner |
| `g2048/server.py` | agent HTTP server |
| `g2048/validate.py` | fixture runner used by `g2048 validate` |

## Search implementation notes

The expectimax matches the other ports bit for bit (same moves, same values,
same benchmark checksums). For speed in CPython the maxnode layer is inlined
into its parent chance node, and each spawned child is derived incrementally
from the parent: a tile at `(r, c)` only changes row `r` and column `c`, so the
four move results and the leaf evaluations are patched from per-line table
lookups. Leaf evaluations are exact integers and every float operation follows
AI.md's order, so no result depends on these shortcuts.

The transposition table is a set of Python dicts keyed by exact board (one dict
per depth), cleared when it exceeds `0.75 * 2**ttBits` entries at the start of a
search. Because it caches more than the TypeScript reference's lossy table,
`nodes`/`ttHits` metrics can be lower than TS for the same search; decisions
and values are unaffected.
