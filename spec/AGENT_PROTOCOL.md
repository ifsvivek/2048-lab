# Agent protocol v1

Every agent — built-in, remote, worker-based, Python/Rust/Go, LLM-backed —
implements one operation: **given an observation, return a direction.**

There are two ways an external agent participates:

1. **Pull (agent drives the game)** — the agent calls the platform API:
   `POST /v1/games` → loop `POST /v1/games/{id}/moves` until `over`. No inbound
   network access needed; works from a laptop, a notebook or a CI job.
2. **Push (platform drives the agent)** — the agent exposes an HTTPS endpoint
   implementing `POST /decide` below and registers it via `POST /v1/agents`.
   The platform (a Durable Object) calls it once per move.

Both use the same observation shape.

## `POST /decide`

Request (`AgentRequest`):

```json
{
  "gameId": "01J9Z6N8Q4K7M2V3X5Y6Z7A8B9",
  "seed": 3141592653,
  "specVersion": 1,
  "board": [[0, 2, 0, 0], [0, 0, 4, 0], [0, 0, 0, 0], [2, 0, 0, 0]],
  "boardHex": "0100002000001000",
  "score": 0,
  "moveCount": 0,
  "validMoves": ["up", "down", "left", "right"]
}
```

* `board` — tile **values**, `board[row][col]`, row 0 on top, 0 = empty.
* `boardHex` — the canonical exponent encoding (SPEC §1).
* `validMoves` — directions that change the board, in canonical order.

Response (`AgentResponse`):

```json
{ "move": "left", "metrics": { "timeUs": 812, "nodes": 10432, "depth": 3 } }
```

* `move` — one of `up`, `down`, `left`, `right` (single letters `U D L R` are
  also accepted). Must be one of `validMoves`.
* `metrics` — optional, free-form numbers; `timeUs`, `nodes`, `depth` are
  surfaced in spectator views and stored with the replay's timing data.

Batching: an agent may return `{ "moves": ["left", "up", ...] }` to commit to
a sequence; the platform applies them in order and stops at the first invalid
one (useful for high-latency agents such as LLMs — though they cannot see the
spawns in between).

Errors / timeouts: the platform gives each call `timeoutMs` (default 5000).
Three consecutive failures abort the run with status `agent_error`.

## Implementations in this repo

| Language   | Server                                     |
|------------|--------------------------------------------|
| Python     | `engines/python` → `g2048 serve`           |
| Go         | `engines/go` → `go run ./cmd/g2048 serve`  |
| Rust       | `engines/rust` → `g2048 serve`             |
| TypeScript | `apps/api` built-in agents                 |
| LLM        | `agents/llm-agent` (Python, Claude API)    |
