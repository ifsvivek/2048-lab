# g2048 — C port

C11 implementation of the canonical 2048 engine (`spec/SPEC.md`) and the
canonical expectimax agent (`spec/AI.md`). Standard library (plus POSIX
`clock_gettime` / `getrusage`) only; the JSON parser/writer is built in.

```
src/engine.[ch]    rules: RNG (mix32 + xoshiro128**), board, moves, spawn, game,
                   hashes, replay verification, boardHex, replay codes, ULIDs
src/ai.[ch]        uint64 bitboard + line tables, heuristic, expectimax (exact TT,
                   iterative deepening), random / greedy / expectimax agents
src/bench.[ch]     benchmark-suite runner -> BenchmarkResult JSON
src/validate.[ch]  fixture checks used by `validate`
src/json.[ch]      minimal JSON DOM: parser + Go-compatible writer
src/main.c         CLI
```

## Usage

```sh
cd engines/c
make                                    # -> bin/g2048 (cc -std=c11 -O2 -Wall -Wextra -ffp-contract=off)
./bin/g2048 validate                    # human summary; --json for a machine report
./bin/g2048 bench --suite ../../spec/benchmarks/engine-random-1k.json --out result.json
./bin/g2048 play --seed 42 --agent expectimax --depth auto
```

`make CC=clang` works too; both gcc and clang build warning-free.

`validate` exits 1 on any failure. `--fixtures DIR` overrides the fixture
directory (default: the first of `../../spec/fixtures`, `spec/fixtures`,
`../spec/fixtures`, `../../../spec/fixtures` that exists); `--skip-bench` skips
running the benchmark suites in `benchmarks.json`. Suites tagged `heavy` are
not run by `validate`; run them with `bench` and compare against
`spec/fixtures/benchmarks-heavy.json`.

`bench` writes the result JSON to `--out` (or stdout) and progress to stderr.
`implementation.runtime` is `native` and `runtimeVersion` is the compiler
(`__VERSION__`, e.g. `gcc 16.2.1`); `peakMemoryBytes` comes from `getrusage`.

`play` prints the final snapshot plus the move string; `--max-moves N` stops early.

The `serve` command of the Go port is not implemented here.

## Notes

* Built with `-ffp-contract=off` so the compiler never fuses `sum + 0.9*v`
  into an FMA; search values are bit-identical to the TypeScript reference.
* The transposition table mirrors the reference (same slot hash, 4-slot probe,
  replacement policy, clear at 75% full, 2^20 slots by default via `ttBits`),
  so `nodes` and `ttHits` metrics are directly comparable across ports.
* `timeBudgetMs > 0` in an agent config enables iterative deepening; results
  are then reported with `deterministic: false`.
