# g2048 — Java port

Java implementation of the canonical 2048 engine (`spec/SPEC.md`) and the
canonical expectimax agent (`spec/AI.md`). JDK standard library only (no
Maven/Gradle, no external dependencies); builds with `javac --release 21`.

```
src/main/java/dev/g2048/
  engine/        rules: RNG (mix32 + xoshiro128**), board, moves, spawn, Game,
                 hashes, replay verification, boardHex, replay codes, ULIDs
  ai/            long bitboard + line tables, heuristic, expectimax (exact TT,
                 iterative deepening), random / greedy / expectimax agents
  bench/         benchmark-suite runner -> BenchmarkResult JSON
  validate/      fixture checks (mirrors the Go validator case-for-case)
  json/          minimal JSON parser / writer
  cli/           CLI (Main)
scripts/g2048    launcher script, copied to bin/g2048 by make
```

## Usage

```sh
cd engines/java
make                                    # -> bin/g2048.jar + bin/g2048 launcher
./bin/g2048 validate                    # human summary; --json for a machine report
./bin/g2048 bench --suite ../../spec/benchmarks/engine-random-1k.json --out result.json
./bin/g2048 play --seed 42 --agent expectimax --depth auto
```

`validate` exits 1 on any failure. `--fixtures DIR` overrides the fixture
directory; `--skip-bench` skips running benchmark suites.

`bench` writes the result JSON to `--out` (or stdout) and progress to stderr.

There is no `serve` command in this port.

## Notes

* Unsigned 32-bit arithmetic uses Java `int` (wrap-around multiply, `>>>`,
  `Integer.toUnsignedLong`); the bitboard is a `long`.
* Java floating point is strict IEEE 754 and `javac`/HotSpot never fuse
  `sum + 0.9 * v` into an FMA, so search values are bit-identical to the
  TypeScript reference (all `ai.json` search values compare exactly equal).
* The transposition table mirrors the reference (same slot hash, 4-slot probe,
  replacement policy, clear at 75% full, 2^20 slots by default via `ttBits`),
  so `nodes` and `ttHits` metrics are directly comparable across ports.
* `peakMemoryBytes` is the process peak RSS (`VmHWM` from `/proc/self/status`,
  comparable to `getrusage` maxrss in other ports); it includes the JVM's own
  footprint. `cpuMs` is process CPU time (all threads, incl. JIT compiler).
* The launcher runs `java -XX:+UseSerialGC ...`; set `G2048_JAVA_OPTS` to add
  JVM flags. Short suites include JIT warm-up in their wall time.
