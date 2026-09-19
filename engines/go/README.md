# g2048 — Go port

Go implementation of the canonical 2048 engine (`spec/SPEC.md`) and the
canonical expectimax agent (`spec/AI.md`). Standard library only.

```
engine/          rules: RNG (mix32 + xoshiro128**), board, moves, spawn, Game,
                 hashes, replay verification, boardHex, replay codes, ULIDs
ai/              uint64 bitboard + line tables, heuristic, expectimax (exact TT,
                 iterative deepening), random / greedy / expectimax agents
bench/           benchmark-suite runner -> BenchmarkResult JSON
internal/validate  fixture checks shared by `validate` and the tests
cmd/g2048/       CLI
```

## Usage

```sh
cd engines/go
go vet ./... && go test ./...           # all fixtures, incl. deterministic benchmark suites
go run ./cmd/g2048 validate             # human summary; --json for a machine report
go run ./cmd/g2048 bench --suite ../../spec/benchmarks/engine-random-1k.json --out result.json
go run ./cmd/g2048 play --seed 42 --agent expectimax --depth auto
go run ./cmd/g2048 serve --addr :8080 --agent expectimax --depth auto [--time-budget-ms 50]
```

`validate` exits 1 on any failure. `--fixtures DIR` overrides the fixture
directory; `--skip-bench` skips running benchmark suites.

`bench` writes the result JSON to `--out` (or stdout) and progress to stderr.

`serve` implements `POST /decide` from `spec/AGENT_PROTOCOL.md` (accepts
`boardHex` or the `board` value matrix, returns
`{"move": "left", "metrics": {...}}`) plus `GET /health`, with permissive CORS.
For the random agent the RNG is re-seeded from `seed` when a new game starts.

## Notes

* Chance-node products are written as `sum + float64(0.9*v)` so the Go compiler
  never fuses them into FMA; search values are bit-identical to the TypeScript
  reference.
* The transposition table mirrors the reference (same slot hash, 4-slot probe,
  replacement policy, clear at 75% full, 2^20 slots by default via `ttBits`),
  so `nodes` and `ttHits` metrics are directly comparable across ports.
* `--time-budget-ms > 0` enables iterative deepening; results are then reported
  with `deterministic: false`.
