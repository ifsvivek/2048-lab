# Architecture

```
                         ┌──────────────────────── Cloudflare ─────────────────────────┐
 Browser (SvelteKit PWA) │  g2048-web (Worker + static assets)                           │
  • local engine + AI    │                                                               │
    worker (offline)     │  g2048-api (Hono Worker) ──── D1 (games, agents, benchmarks,  │
  • IndexedDB games      │     │   │        │             analytics aggregates)          │
  • service worker cache │     │   │        └─ cron: daily analytics rollup              │
        │  REST/WS ──────┼──►  │   ├─ GameSession DO  (live game: SQLite move log,      │
        │                │     │   │                   spectator WebSockets, alarms)    │
 External agents ───────►│     │   └─ BenchmarkSession DO (server-run benchmarks)       │
  REST pull / push        │     ▲                                                         │
 MCP clients ────────────►│  g2048-mcp (Hono, Streamable HTTP) ── service binding ─┘      │
                         └───────────────────────────────────────────────────────────────┘
 Native runners (Rust / Go / Python / Node) ── run shared suites ──► POST /v1/benchmarks/runs
```

## Flows

**Human game.** Everything happens in the browser. The seed, game ID and
replay code are generated locally, moves are applied by the TypeScript engine,
and the game is saved to IndexedDB after every move. When the game ends it is
uploaded once as `(seed, moves, timing)`. The API re-simulates it, stores one
row and folds it into the analytics aggregates, all in one D1 batch.
Offline games queue and sync on reconnect.

**API or MCP game.** `POST /v1/games` creates a `GameSession` Durable Object
keyed by the game ID. Each move request is validated by the engine, persisted
to the object's SQLite before responding, and broadcast to spectators as move
letters (spectators rebuild the board locally). At game over the Durable Object
writes the final row and the rollups to D1, then deletes its storage.

**Platform-driven agent.** For built-ins and registered push agents, the
Durable Object's alarm loop runs batches of decisions (in-process agents, or
`POST /decide` on the agent's endpoint), pacing itself for spectators.

**Benchmarks.** Suites in `spec/benchmarks` define workloads. Each language's
CLI emits the same `BenchmarkResult` JSON. The API marks a run `verified` when
its checksum matches the reference fixture. The runtime dashboard merges the
committed baseline (bundled, so it works offline) with submitted runs.

**Analytics.** Covered in ADR 0004. Aggregates are written incrementally when
a game finishes, and a daily cron computes players, retention and snapshots.
Dashboards read only those tables and are edge-cached.

## Determinism boundary

| Deterministic (spec-governed, fixture-tested) | Not deterministic |
|---|---|
| RNG, spawns, moves, scores, history hash | wall-clock timing, memory |
| Random agent (SPEC §10), greedy agent | expectimax with `timeBudgetMs > 0` (flagged `deterministic: false`) |
| Expectimax decisions and root values (AI.md) | search node counts across different transposition-table policies (documented) |
| Benchmark checksums, move and score totals | per-run throughput |

## Adding a language

1. Implement SPEC.md and AI.md.
2. Load `spec/fixtures/*.json` in the port's tests.
3. Provide a CLI with `validate --json` and `bench --suite PATH --out FILE`.
4. Add an entry to `tools/src/runtimes.ts`. `pnpm validate` and `pnpm bench`
   pick it up, and `LANGUAGES` in the API accepts its results once it's added.
