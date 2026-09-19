# g2048 — C++ port

C++20 implementation of the canonical 2048 engine (`spec/SPEC.md`) and the
canonical expectimax agent (`spec/AI.md`). Standard library only (including a
small JSON value type / parser / serializer).

```
include/g2048/   public headers
  json.hpp       JSON value (std::variant), parser, Go-compatible serializer
  engine.hpp     rules: RNG (mix32 + xoshiro128**), board, moves, spawn, Game,
                 hashes, replay verification, boardHex, replay codes, ULIDs
  ai.hpp         uint64 bitboard + line tables, heuristic, expectimax (exact TT,
                 iterative deepening), random / greedy / expectimax agents
  bench.hpp      benchmark-suite runner -> BenchmarkResult JSON
  validate.hpp   fixture checks used by `validate`
src/             implementations + main.cpp (CLI)
```

## Usage

```sh
cd engines/cpp
make                                    # CMake Release build -> bin/g2048
./bin/g2048 validate                    # human summary; --json for a machine report
./bin/g2048 bench --suite ../../spec/benchmarks/engine-random-1k.json --out result.json
./bin/g2048 play --seed 42 --agent expectimax --depth auto
```

`make` wraps CMake (`cmake -S . -B build -DCMAKE_BUILD_TYPE=Release`; falls
back to a direct compiler call when cmake is absent). Flags: `-O2 -Wall -Wextra
-ffp-contract=off`; warning-free with g++ and clang++
(`CXX=clang++ make BUILD_DIR=build-clang`). Every build writes `bin/g2048`.

`validate` exits 1 on any failure. `--fixtures DIR` overrides the fixture
directory; `--skip-bench` skips running benchmark suites. Suites tagged
`heavy` are skipped, as in the Go port.

`bench` writes the result JSON to `--out` (or stdout) and progress to stderr.
`implementation` is `{"language": "cpp", "runtime": "native", "runtimeVersion":
"<compiler version>"}`; `peakMemoryBytes`/`cpuMs` come from `getrusage`.

`serve` is not implemented in this port.

## Notes

* Built with `-ffp-contract=off` so the compiler never fuses the chance-node
  `sum + 0.9 * v` into an FMA; search values are bit-identical to the
  TypeScript reference.
* The transposition table mirrors the reference (same slot hash, 4-slot probe,
  replacement policy, clear at 75% full, 2^20 slots by default via `ttBits`),
  so `nodes` and `ttHits` metrics are directly comparable across ports.
* `timeBudgetMs > 0` in the agent config enables iterative deepening; results
  are then reported with `deterministic: false`.
