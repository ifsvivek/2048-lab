# ADR 0006 — Designing to the Cloudflare free tier

| Resource (free/day) | Budget holder | Design choice |
|---|---|---|
| Worker requests 100k | API | Browser games cost 1 request per game (upload), not per move; SPA assets are served by the assets binding without invoking the Worker; spectators receive WebSocket pushes, not polls. |
| Worker CPU 10 ms | API | Replay verification is ~1 µs/move in V8; server-driven expectimax is capped at depth 2; AI tables are built lazily so they cost nothing at cold start (startup 6 ms). |
| D1 rows written 100k | analytics | ~7–12 rows per finished game, none per move; tiny games (< 10 moves) are never stored. |
| D1 rows read 5M | dashboards | Aggregate tables + edge cache; no dashboard query scans `games`. |
| DO requests / storage | live games | One RPC per move request (no pre-flight existence check), one SQLite row per request, storage deleted when the game ends. |
| Rate limiting | abuse | `CREATE_LIMITER` 30/min and `WRITE_LIMITER` 600/min per IP. |

Heavy benchmarks run on real hardware via the language CLIs and are
*submitted*; the server only verifies checksums.
