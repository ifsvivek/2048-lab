# g2048 — C# port

C# (.NET 9) implementation of the canonical 2048 engine (`spec/SPEC.md`) and
the canonical expectimax agent (`spec/AI.md`). Base class library only (no
NuGet packages); JSON via `System.Text.Json`.

```
src/Engine/      rules: RNG (mix32 + xoshiro128**), board, moves, spawn, Game,
                 hashes, replay verification, boardHex, replay codes, ULIDs
src/Ai/          ulong bitboard + line tables, heuristic, expectimax (exact TT,
                 iterative deepening), random / greedy / expectimax agents
src/Bench/       benchmark-suite runner -> BenchmarkResult JSON
src/Validate/    fixture checks used by `validate`
src/Cli/         CLI + a small Go-compatible JSON writer
bin/g2048        launcher script (runs build/publish/G2048.dll)
```

## Build

Requires the .NET 9 SDK. `make` and `bin/g2048` locate `dotnet` in this order:
`$DOTNET_ROOT/dotnet`, `~/.dotnet/dotnet`, then `dotnet` on `PATH`.

```sh
cd engines/csharp
make                                    # dotnet publish -c Release -o build/publish (framework-dependent)
./bin/g2048 validate                    # human summary; --json for a machine report
./bin/g2048 bench --suite ../../spec/benchmarks/engine-random-1k.json --out result.json
./bin/g2048 play --seed 42 --agent expectimax --depth auto
make clean
```

`validate` exits 1 on any failure. `--fixtures DIR` overrides the fixture
directory; `--skip-bench` skips running the benchmark suites in
`benchmarks.json` (suites tagged `heavy` are never run by `validate`).

`bench` writes the result JSON to `--out` (or stdout) and progress to stderr.
The output mirrors the Go port field-for-field (key order and number
formatting included), with `implementation.language = "csharp"` and
`runtime = "dotnet"`. `peakMemoryBytes` is `Process.PeakWorkingSet64` (VmHWM).

There is no `serve` command in this port.

## Notes

* Chance-node products are computed into a local before the addition
  (`double p = 0.9 * v; sum += p;`); RyuJIT never contracts these into FMA,
  so search values are bit-identical to the TypeScript reference (`validate`
  reports the bit-identical count for `ai.json`).
* The transposition table mirrors the reference (same slot hash, 4-slot probe,
  replacement policy, clear at 75% full, 2^20 slots by default via `ttBits`),
  so `nodes` and `ttHits` metrics are directly comparable across ports.
* Runtime settings (`G2048.csproj`): workstation non-concurrent GC, invariant
  globalization, tiered compilation with dynamic PGO, and
  `TieredCompilation.CallCountingDelayMs = 0` so hot methods reach optimised
  tier-1 code immediately — without it short suites (a few hundred ms) spend
  most of their time in tier-0 code.
* `timeBudgetMs > 0` enables iterative deepening; results are then reported
  with `deterministic: false`.
