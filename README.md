<div align="center">

<img src="apps/web/static/icon.svg" width="88" height="88" alt="2048 Lab logo" />

# 2048 Lab

**A deterministic 2048 platform for humans, AI agents and cross-language benchmarking.**

Play in the browser, watch AI agents live, replay any game from a 12-character code,<br/>
and race TypeScript, Rust, Go and Python on the *exact same* games.

[**Play now →**](https://2048.ifsvivek.in) &nbsp;·&nbsp;
[API](https://g2048-api.ifsvivek.workers.dev/v1/health) &nbsp;·&nbsp;
[MCP server](docs/MCP.md) &nbsp;·&nbsp;
[Spec](spec/SPEC.md) &nbsp;·&nbsp;
[Architecture](docs/architecture.md)

![TypeScript](https://img.shields.io/badge/TypeScript-reference-3178C6?logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-port-B7410E?logo=rust&logoColor=white)
![Go](https://img.shields.io/badge/Go-port-00ADD8?logo=go&logoColor=white)
![Python](https://img.shields.io/badge/Python-port-3776AB?logo=python&logoColor=white)
<br/>
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20·%20D1%20·%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)
![SvelteKit](https://img.shields.io/badge/SvelteKit-5-FF3E00?logo=svelte&logoColor=white)
![Hono](https://img.shields.io/badge/Hono-API-E36002?logo=hono&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-000000)

<img src="docs/images/play-ai.jpg" alt="The built-in expectimax AI playing, with its per-move reasoning" width="100%" />

</div>

---

## ✨ Highlights

<table>
<tr>
<td width="50%" valign="top">

### 🎯 Bit-identical in four languages
Same seed + same moves ⇒ the **same board history** in TypeScript, Rust, Go
and Python. The expectimax AI even makes the **same decision with the same
float64 value**. 3,658 shared fixture checks enforce it.

</td>
<td width="50%" valign="top">

### 🔁 Replays from a short code
Every finished game gets a human-friendly code like `A7KF-29LM-XQ4P`.
Anyone can watch it — play, pause, step, jump, change speed — and the
browser re-verifies it against the stored hash.

</td>
</tr>
<tr>
<td valign="top">

### 🤖 Agents of every kind
Built-in expectimax, greedy and random agents; external agents over REST
(pull) or a `POST /decide` webhook (push); AI assistants over **MCP**;
and an **LLM agent** constrained to legal moves.

</td>
<td valign="top">

### 📊 Benchmarks & analytics
Shared, reproducible suites with verified checksums; a runtime
comparison dashboard; and analytics for growth, retention, score
percentiles, tile achievements and per-agent performance.

</td>
</tr>
<tr>
<td valign="top">

### 📴 Offline-first
Games run entirely in the browser (AI in a Web Worker), are saved to
IndexedDB, and sync one verified replay when you're back online.

</td>
<td valign="top">

### 🪶 Built for the free tier
No per-move database writes, aggregate-only dashboards, edge caching,
and Durable Objects only where coordination actually matters.

</td>
</tr>
</table>

## 🏁 Same games, different speeds

Because every runtime plays identical games, a benchmark measures **speed and
nothing else**. Every row below has the same checksum in all four languages.

| Workload | TypeScript<br/><sub>Node 26</sub> | Rust | Go | Python<br/><sub>CPython 3.14</sub> |
|---|--:|--:|--:|--:|
| Engine throughput — random agent, moves/s | 1.08 M | **4.25 M** | 2.91 M | 89 K |
| Expectimax depth 2 — time per decision | 24 µs | 13 µs | **11 µs** | 306 µs |
| Expectimax depth 3 — search nodes/s | 35 M | 72 M | **76 M** | 2.8 M |
| Peak memory, depth-2 suite | 115 MB | **28 MB** | 35 MB | 229 MB |
| Canonical AI (auto depth 2–4), avg score over 3 games | 168,737 | 168,737 | 168,737 | 168,737 |
| Canonical AI — time per decision | 3.7 ms | 1.8 ms | **1.8 ms** | 43 ms |

<sub>AMD Ryzen 7 5800H · reproduce with <code>pnpm bench</code> · live numbers on the <a href="https://2048.ifsvivek.in/runtimes">runtime dashboard</a></sub>

```text
$ pnpm validate
  typescript  ok   1106 passed, 0 failed
  rust        ok    407 passed, 0 failed
  go          ok   1114 passed, 0 failed
  python      ok   1031 passed, 0 failed
  engine-random-1k   expected 3d653498   typescript=3d653498 rust=3d653498 go=3d653498 python=3d653498   IDENTICAL
  expectimax-d2-10   expected 33601a3a   typescript=33601a3a rust=33601a3a go=33601a3a python=33601a3a   IDENTICAL
```

## 📸 Tour

<table>
<tr>
<td width="50%"><img src="docs/images/home.jpg" alt="Landing page" /><p align="center"><sub><b>Landing</b> — start a game or open a replay</sub></p></td>
<td width="50%"><img src="docs/images/replay.jpg" alt="Replay viewer" /><p align="center"><sub><b>Replay viewer</b> — verified, step-by-step playback</sub></p></td>
</tr>
<tr>
<td><img src="docs/images/runtimes.jpg" alt="Runtime comparison dashboard" /><p align="center"><sub><b>Runtime comparison</b> — TypeScript vs Rust vs Go vs Python</sub></p></td>
<td><img src="docs/images/analytics.jpg" alt="Analytics dashboard" /><p align="center"><sub><b>Analytics</b> — growth, players, scores, agents</sub></p></td>
</tr>
</table>

<p align="center"><img src="docs/images/mobile.jpg" alt="Mobile" width="260" /><br/><sub><b>Mobile</b> — swipe to play, works offline</sub></p>

## 🧭 Architecture

```mermaid
%%{init: {"theme": "neutral"}}%%
flowchart LR
    subgraph Clients
        B["🌐 Browser PWA<br/>engine + AI worker<br/>IndexedDB · offline"]
        A["🤖 External agents<br/>REST pull · webhook push"]
        M["🧠 MCP clients<br/>Claude Code · Cursor · Codex"]
        R["⚙️ Native runners<br/>Rust · Go · Python · Node"]
    end
    subgraph Cloudflare
        W["g2048-web<br/>SvelteKit Worker"]
        API["g2048-api<br/>Hono Worker"]
        MCP["g2048-mcp<br/>stateless MCP"]
        GS[("GameSession DO<br/>live games · spectators")]
        BS[("BenchmarkSession DO")]
        D1[("D1<br/>games · agents · benchmarks<br/>analytics aggregates")]
    end
    B --> W
    B -- "upload verified replay" --> API
    A --> API
    M --> MCP -- "service binding" --> API
    R -- "submit results" --> API
    API --> GS & BS
    API --> D1
    GS -- "once, at game end" --> D1
```

**Key decisions** — each has a short record in [`docs/adr`](docs/adr):
[canonical spec & fixtures](docs/adr/0001-canonical-spec-and-fixtures.md) ·
[Durable Objects](docs/adr/0002-durable-objects.md) ·
[offline-first & identities](docs/adr/0003-offline-first-and-identities.md) ·
[analytics](docs/adr/0004-analytics.md) ·
[MCP](docs/adr/0005-mcp.md) ·
[free-tier budget](docs/adr/0006-free-tier-budget.md)

## 🚀 Quick start

```bash
pnpm install
pnpm test          # TypeScript unit + fixture tests
pnpm validate      # all four languages against the shared fixtures
```

<details>
<summary><b>Run the whole stack locally</b></summary>

```bash
pnpm --filter @g2048/api db:migrate:local
pnpm dev:api                      # API  → http://localhost:8787
pnpm --filter @g2048/mcp dev      # MCP  → http://localhost:8788/mcp
pnpm dev:web                      # Web  → http://localhost:5173

node tools/src/smoke-api.ts       # end-to-end API checks vs the reference engine
node tools/src/smoke-mcp.ts       # plays a whole game through MCP (official SDK client)
node tools/src/seed-demo.ts       # synthetic history for the analytics dashboard (localhost only)
```
</details>

<details>
<summary><b>Benchmarks</b></summary>

```bash
pnpm bench                                                    # default suites, every runtime
pnpm bench --suites expectimax-canonical-3 --lang rust,go     # pick suites / languages
pnpm bench --submit https://g2048-api.ifsvivek.workers.dev    # publish (checksums are verified)
```

Suites live in [`spec/benchmarks`](spec/benchmarks); results follow
[`benchmark-result.schema.json`](spec/schemas/benchmark-result.schema.json).
</details>

<details>
<summary><b>Deploy (Cloudflare)</b></summary>

```bash
cd apps/api && npx wrangler d1 migrations apply g2048 --remote && npx wrangler deploy
cd apps/mcp && npx wrangler deploy
cd apps/web && pnpm run deploy
```
</details>

## 🤝 Bring your own agent

| Integration | How | Example |
|---|---|---|
| **REST (pull)** | `POST /v1/games`, then `POST /v1/games/{id}/moves` until `status` is `over` — every response is the full state | [`agents/python-api-agent`](agents/python-api-agent/play.py) |
| **Webhook (push)** | Serve `POST /decide`, register it, and the platform plays your agent live | `g2048 serve` in [Rust](engines/rust), [Go](engines/go), [Python](engines/python) |
| **MCP** | `claude mcp add --transport http g2048 https://g2048-mcp.ifsvivek.workers.dev/mcp` | [`docs/MCP.md`](docs/MCP.md) |
| **LLM** | Free OpenRouter model by default, or Claude; answers are schema-restricted to legal moves | [`agents/llm-agent`](agents/llm-agent/agent.py) |

```bash
curl -s -X POST https://g2048-api.ifsvivek.workers.dev/v1/games -d '{"seed": 42}'
curl -s -X POST https://g2048-api.ifsvivek.workers.dev/v1/games/$GAME_ID/moves -d '{"move": "left"}'
```

Full contract: [`spec/openapi.yaml`](spec/openapi.yaml) · agent protocol: [`spec/AGENT_PROTOCOL.md`](spec/AGENT_PROTOCOL.md)

## 🗂️ Repository

| Path | What's inside |
|---|---|
| [`spec/`](spec) | Game & AI specs, agent protocol, OpenAPI, JSON schemas, **cross-language fixtures**, benchmark suites |
| [`packages/engine`](packages/engine) | TypeScript reference engine, expectimax, simulation & benchmark core |
| [`engines/rust`](engines/rust) · [`engines/go`](engines/go) · [`engines/python`](engines/python) | Ports with `validate` / `bench` / `play` / `serve` CLIs (Python also ships an API client) |
| [`apps/api`](apps/api) | Hono API on Workers · D1 · Durable Objects · daily analytics cron |
| [`apps/mcp`](apps/mcp) | MCP server — Hono, Streamable HTTP, stateless, service-bound to the API |
| [`apps/web`](apps/web) | SvelteKit + Tailwind frontend (Worker, offline-first PWA) |
| [`agents/`](agents) | Example external agents |
| [`tools/`](tools) | Fixture generation, cross-language validation, benchmarks, smoke & visual tests |
| [`docs/`](docs) | Architecture, decision records, MCP guide |

<div align="center">
<sub>Every game is a seed and a list of moves — everything else is derived.</sub>
</div>
