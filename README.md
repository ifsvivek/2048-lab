# 2048 Lab

A research and benchmarking platform for 2048: human play, built-in and
external AI agents, reproducible replays, cross-language benchmarks and
analytics. Everything runs on Cloudflare's free tier.

| | URL |
|---|---|
| Web app | https://g2048-web.ifsvivek.workers.dev |
| API | https://g2048-api.ifsvivek.workers.dev (`/v1/...`, contract: [`spec/openapi.yaml`](spec/openapi.yaml)) |
| MCP | https://g2048-mcp.ifsvivek.workers.dev/mcp ([docs/MCP.md](docs/MCP.md)) |

## The core idea: one game, four languages, bit-identical

Every implementation (TypeScript, Rust, Go and Python) produces the **same
board history** for the same `(seed, moves)`. The built-in expectimax AI also
makes the **same decision with the same float64 value** for the same board.
This is enforced by [`spec/SPEC.md`](spec/SPEC.md), [`spec/AI.md`](spec/AI.md)
and 9 fixture files that every port must pass:

```
$ pnpm validate
  typescript  ok   1106 passed, 0 failed
  rust        ok    407 passed, 0 failed
  go          ok   1114 passed, 0 failed
  python      ok   1031 passed, 0 failed
  engine-random-1k   expected 3d653498  typescript=3d653498 rust=3d653498 go=3d653498 python=3d653498  IDENTICAL
  expectimax-d2-10   expected 33601a3a  typescript=33601a3a rust=33601a3a go=33601a3a python=33601a3a  IDENTICAL
```

Because all runtimes play the same games, benchmarks measure speed alone.
Measured on a Ryzen 7 5800H:

| Suite | TypeScript (Node 26) | Rust | Go | Python (CPython 3.14) |
|---|---|---|---|---|
| Engine, random agent (moves/s) | 1.08 M | **4.25 M** | 2.91 M | 89 K |
| Expectimax depth 2 (µs per decision) | 24.3 | 12.5 | **11.1** | 306 |
| Expectimax depth 3 (search nodes/s) | 35 M | 72 M | **76 M** | 2.8 M |
| Canonical AI, 3 full games (avg score) | 168,737 | 168,737 | 168,737 | *(see results)* |
| Peak memory, depth-2 suite | 115 MB | **28 MB** | 35 MB | 229 MB |

## Repository

```
spec/            canonical rules, AI spec, agent protocol, OpenAPI, JSON schemas,
                 cross-language fixtures, shared benchmark suites
packages/engine  TypeScript reference engine + expectimax + simulation/benchmark core
engines/rust     Rust port        (cargo test · g2048 validate|bench|play|serve)
engines/go       Go port          (go test   · g2048 validate|bench|play|serve)
engines/python   Python port      (pytest    · g2048 validate|bench|play|serve) + API client
apps/api         Hono API on Cloudflare Workers · D1 · Durable Objects · cron
apps/mcp         MCP server (Hono, Streamable HTTP, stateless, service-bound to the API)
apps/web         SvelteKit + Tailwind frontend (Cloudflare Worker, offline-first PWA)
agents/          example external agents: Python API agent, LLM agent (OpenRouter / Claude)
tools/           fixture generation, cross-language validation, benchmarks, smoke tests
results/         benchmark results (baseline/index.json is committed)
docs/            architecture, decision records, MCP guide
```

## Quick start

```bash
pnpm install
pnpm test && pnpm validate      # TS tests, then all four languages against the fixtures

# local stack
pnpm --filter @g2048/api db:migrate:local
pnpm dev:api                    # http://localhost:8787
pnpm --filter @g2048/mcp dev    # http://localhost:8788/mcp
pnpm dev:web                    # http://localhost:5173 (uses .env.development)

node tools/src/smoke-api.ts     # end-to-end API checks against the reference engine
node tools/src/smoke-mcp.ts     # plays a full game through MCP with the official SDK client
```

Benchmarks:

```bash
pnpm bench --suites engine-random-1k,expectimax-d2-10          # all runtimes → results/local
pnpm bench --lang rust,go --submit https://g2048-api.ifsvivek.workers.dev
```

## Playing as an agent

* **REST (pull):** `POST /v1/games`, then `POST /v1/games/{id}/moves` until
  `status` is `over`. Every response is the full state. See
  [`agents/python-api-agent`](agents/python-api-agent/play.py).
* **Push:** implement `POST /decide` ([`spec/AGENT_PROTOCOL.md`](spec/AGENT_PROTOCOL.md)),
  register it, and the platform drives it (spectators watch live). Reference
  servers: `g2048 serve` in all three native ports.
* **MCP:** `claude mcp add --transport http g2048 https://g2048-mcp.ifsvivek.workers.dev/mcp`.
* **LLM:** [`agents/llm-agent`](agents/llm-agent/agent.py) uses a free OpenRouter model
  by default (`OPENROUTER_API_KEY` in `.env`) or Claude (`--provider anthropic`).
  Structured outputs restrict each answer to the legal moves.

## Deploy

```bash
cd apps/api && npx wrangler d1 migrations apply g2048 --remote && npx wrangler deploy
cd apps/mcp && npx wrangler deploy
cd apps/web && pnpm run deploy
```

## Design notes

[Architecture](docs/architecture.md) ·
[ADR 0001 spec & fixtures](docs/adr/0001-canonical-spec-and-fixtures.md) ·
[0002 Durable Objects](docs/adr/0002-durable-objects.md) ·
[0003 offline-first & identities](docs/adr/0003-offline-first-and-identities.md) ·
[0004 analytics](docs/adr/0004-analytics.md) ·
[0005 MCP](docs/adr/0005-mcp.md) ·
[0006 free-tier budget](docs/adr/0006-free-tier-budget.md)
