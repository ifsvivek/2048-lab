# g2048 — Rust port

Native Rust implementation of the canonical 2048 engine (`spec/SPEC.md`) and the
canonical expectimax agent (`spec/AI.md`). It must reproduce every value in
`spec/fixtures/` exactly — same games, same hashes, same AI decisions and
values as the TypeScript reference.

Dependencies: `serde` (derive) and `serde_json` only. Edition 2021, stable Rust.

## Layout

| Path | Contents |
|------|----------|
| `src/rng.rs` | `mix32` seed expansion, xoshiro128\*\*, unbiased `below(n)` (SPEC §4) |
| `src/board.rs` | exponent board, canonical line order, moves, spawn (SPEC §1–§3, §5) |
| `src/hash.rs` | FNV-1a board / history hashes (SPEC §7) |
| `src/game.rs` | `Game` lifecycle and `Snapshot` (SPEC §6) |
| `src/replay.rs` | `simulate` / `verify_replay` with `INVALID_MOVE_AT`, `BAD_LETTER`, `SPEC_VERSION`, `FINAL_MISMATCH` (SPEC §8) |
| `src/ids.rs` | seeds, ULIDs, replay codes (SPEC §9) |
| `src/ai/` | u64 bitboard + 65536-entry line tables, integer-weight heuristic, canonical expectimax with the reference transposition-table policy, and the `random` / `greedy` / `expectimax` agents |
| `src/bench.rs` | benchmark-suite runner emitting `BenchmarkResult` JSON |
| `src/server.rs` | HTTP agent server (`POST /decide`, `GET /health`, CORS) |
| `src/fixtures.rs` | conformance checks against `spec/fixtures/*.json` |
| `tests/fixtures.rs` | `cargo test` entry point for the conformance checks |

## Usage

```sh
cd engines/rust
cargo build --release

# conformance (exit code 1 on any failure)
./target/release/g2048 validate
./target/release/g2048 validate --json            # {"language":"rust","passed":N,"failed":M,"failures":[...]}
./target/release/g2048 validate --fixtures ../../spec/fixtures

# benchmarks (BenchmarkResult JSON, spec/schemas/benchmark-result.schema.json)
./target/release/g2048 bench --suite ../../spec/benchmarks/engine-random-1k.json
./target/release/g2048 bench --suite ../../spec/benchmarks/expectimax-d2-10.json --out result.json

# play one game and print a SPEC §8 replay
./target/release/g2048 play --seed 42 --agent expectimax --depth auto
./target/release/g2048 play --seed 42 --agent random

# agent server (spec/AGENT_PROTOCOL.md)
./target/release/g2048 serve --addr 0.0.0.0:8080 --agent expectimax --depth auto
./target/release/g2048 serve --time-budget-ms 50     # iterative deepening, non-deterministic
curl -s localhost:8080/health
curl -s -XPOST localhost:8080/decide -d '{"seed":1,"specVersion":1,"boardHex":"0100002000001000","score":0,"moveCount":0}'
```

`--depth` accepts `auto` (canonical: `clamp(distinct - 2, 2, 4)`) or a fixed
integer. `--time-budget-ms N > 0` enables iterative deepening; results are then
reported with `deterministic: false`.

## Verification

CI is the verification path:

```sh
cargo test --release
```

This runs one test per fixture file (`rng`, `moves`, `spawn`, `hash`, `games`,
`replays`, `codes`, `ai`, `benchmarks`) plus unit checks for replay errors,
timestamps, identifiers, the bitboard transpose and the reference TT node
counts. The `games` test re-plays the random and depth-2 expectimax agents and
requires identical move strings; the `benchmarks` test runs
`engine-random-1k`, `expectimax-d2-10` and `expectimax-d3-opening` and compares
checksum, games, total moves, total score and max score with
`spec/fixtures/benchmarks.json`. The test profile is built with `opt-level = 3`,
so plain `cargo test` is also reasonably fast.

## Determinism notes

* All RNG / hash arithmetic uses explicit `wrapping_*` / `rotate_left` on `u32`;
  `below(n)` computes its rejection limit in `u64`.
* The expectimax chance node accumulates `sum = sum + 0.9 * v2; sum = sum + 0.1 * v4`
  in `f64`. Rust never contracts these into fused multiply-adds, so values are
  bit-identical to the reference.
* Direction ties keep the lower index (strict `>`), maxnodes start at `0.0`.
* The transposition table uses the reference policy from `spec/AI.md` (TS slot
  hash, 4-slot linear probe, `2^ttBits` slots, cleared at >75 % occupancy), so
  `nodes` / `ttHits` / `ttSize` match the TypeScript engine as well. Benchmark
  results report `environment.ttPolicy = "reference"`.
