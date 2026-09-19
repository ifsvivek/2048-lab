# ADR 0002 — Where Durable Objects are (and are not) used

**Status:** accepted

## Decision
Durable Objects are used for exactly two things, where coordination is the
point:

| DO | Why a DO |
|----|----------|
| `GameSession` (one per live server game) | Serialises concurrent moves without locks; hibernatable WebSockets fan out moves to spectators at zero idle cost; alarms drive platform-run agents; move history lives in the object's own SQLite until the game ends. |
| `BenchmarkSession` (one per server benchmark) | A session outlives any request (hundreds of alarm-driven batches) and needs a single owner of progress plus live progress streaming. |

Everything else is a stateless Worker over D1: replay upload/fetch,
leaderboards, analytics, agents, benchmark runs. Browser games never touch a
DO — they run locally and upload one verified replay (ADR 0003).

## Persistence rules (from Cloudflare's DO best practices)
* **Persist first.** Each move request is written to the object's SQLite
  (`sql.exec`, synchronous) before the response is released by the output
  gate; memory is restored from storage in the constructor with
  `blockConcurrencyWhile`. A restarted runtime resumes a game with an
  identical history hash (verified locally by killing `wrangler dev` mid-game).
* **One row per request, not per move.** Clients that batch moves pay one
  write per batch.
* **D1 once per game.** The game row is written at creation (so its replay
  code resolves while live) and once when it ends, together with all
  analytics rollups in one `batch()`. Then `deleteAll()` frees the object.
* Routing uses `getByName(gameId)`; alarms are idempotent and self-back-off.

## Rejected
* A global lobby/counter DO (single-instance bottleneck, anti-pattern).
* Per-move D1 writes (free tier: 100k rows/day ≈ a few AI games).
