# g2048 — Lua port

Pure-Lua implementation of the canonical 2048 engine (`spec/SPEC.md`) and the
canonical expectimax agent (`spec/AI.md`). Standard library only: no rocks,
no C modules. Requires **Lua 5.4 or newer** (tested with 5.4.9 and 5.5.1).

**LuaJIT is not supported.** The port relies on Lua 5.3+ native 64-bit
integers, integer division (`//`) and bitwise operators (`& | ~ << >>`) for
uint32 RNG/hash arithmetic and the 64-bit bitboard. LuaJIT implements Lua 5.1
semantics (doubles only, `bit` library limited to 32 bits), so it cannot run
this code.

```
g2048/rng.lua         mix32 + xoshiro128** (masked uint32 math)
g2048/board.lua       exponent boards, lines, moves, spawn, boardHex
g2048/hash.lua        FNV-1a board / history hashes
g2048/game.lua        Game lifecycle (SPEC §6)
g2048/replay.lua      replay simulation + verification (SPEC §8)
g2048/ids.lua         replay codes, ULIDs, random seeds
g2048/bitboard.lua    64-bit bitboard, 65536-entry line tables, transpose
g2048/heuristic.lua   integer heuristic, line tables, breakdown
g2048/expectimax.lua  canonical expectimax, reference transposition table
g2048/agents.lua      random / greedy / expectimax agents
g2048/json.lua        JSON decoder/encoder (Go encoding/json-compatible output)
g2048/bench.lua       benchmark-suite runner -> BenchmarkResult JSON
g2048/validate.lua    fixture checks
main.lua              CLI
bin/g2048             sh launcher (sets LUA_PATH, picks a Lua >= 5.4)
```

## Usage

```sh
cd engines/lua
make                                    # checks for Lua >= 5.4, chmods the launcher
bin/g2048 validate                      # human summary; --json for a machine report
bin/g2048 bench --suite ../../spec/benchmarks/engine-random-1k.json --out result.json
bin/g2048 play --seed 42 --agent expectimax --depth auto
```

The launcher tries `$G2048_LUA`, then `lua`, `lua5.5`, `lua5.4`, `lua55`,
`lua54`, and uses the first whose `-v` reports version 5.4 or newer. To force
an interpreter: `G2048_LUA=lua5.4 bin/g2048 validate`.

* `validate [--fixtures DIR] [--json] [--skip-bench] [--heavy]` runs every
  fixture in `spec/fixtures` (including the three `benchmarks.json` suites,
  about 7 s in total) and exits 1 on any failure. `--json` prints
  `{"language":"lua","engineVersion":"1.0.0","passed":N,"failed":M,"failures":[...]}`.
  `benchmarks-heavy.json` is skipped unless you pass `--heavy`, the same way
  the Go and Python validators skip it. `engine-random-10k` takes about 5 s;
  `expectimax-canonical-3` probably needs well over an hour in Lua.
* `bench --suite FILE [--out FILE]` writes a `BenchmarkResult` to `--out` (or
  stdout) and progress to stderr. Field order, number formatting and summary
  definitions match the Go port. `language` is `"lua"`, `runtime` is `"lua"`,
  and `runtimeVersion` is the interpreter's full version (e.g. `5.5.1`).
* `play --seed N [--agent expectimax|random|greedy] [--depth auto|N] [--max-moves N]`
  plays one game and prints the final snapshot, node count and move string.

`serve` (the HTTP agent protocol) is not implemented in this port.

## Notes

* **uint32 arithmetic.** Every RNG and hash step is masked with `0xffffffff`.
  A product of two 32-bit values wraps modulo 2^64 in Lua, which keeps the low
  32 bits exact, so `(a * b) & 0xffffffff` is a correct `imul`.
* **Bitboard.** The 64-bit board is a plain Lua integer. `>>` is a logical
  shift, so boards with bit 63 set still extract correctly. Column moves and
  column evaluation go through a 4×4 nibble transpose.
* **Floats.** `sum = sum + 0.9 * v` compiles to separate MUL and ADD VM
  instructions, so there is no FMA. Search values are bit-identical to the
  reference, and all 60 `ai.json` searches match exactly. Leaf evaluations are
  exact integers, updated incrementally when a spawned tile changes one row and
  one column.
* **Transposition table.** Mirrors the reference: same slot hash, 4-slot
  probe, replacement policy, clear at 75% full, 2^20 slots by default
  (`ttBits`). `nodes` and `ttHits` match the Go port exactly (for example
  11,723,911 nodes on `expectimax-d2-10`), so no `ttPolicy` caveat applies.
* **Timing.** Pure Lua has no sub-second wall clock. Per-game `wallMs` and
  per-decision `timeUs` (so `avgDecisionUs`/`p50`/`p99`) use `os.clock()`,
  which is process CPU time. For this single-threaded, CPU-bound loop that is
  effectively wall time. The suite total `wallMs`, and the throughput numbers
  derived from it, come from `date +%s%N` read once at the start and once at
  the end, falling back to `os.clock()` if `date` is unavailable. `cpuMs` is
  `os.clock()`. `peakMemoryBytes` is `VmHWM` from `/proc/self/status`, or
  `null` where that file does not exist.
* `--time-budget-ms` style configs (`timeBudgetMs > 0` in a suite config)
  enable iterative deepening. The deadline uses `os.clock()`, and results are
  reported with `deterministic: false`.
