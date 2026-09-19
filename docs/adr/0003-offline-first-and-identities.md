# ADR 0003 — Offline-first play, and game ID vs replay code

**Status:** accepted

## Decision
* **Local-first.** Starting a game in the browser generates the seed, a ULID
  game ID and a 60-bit replay code on the device; play needs no network. Games
  are kept in IndexedDB; finished games are uploaded once (≥ 10 moves), queued
  while offline and flushed on reconnect.
* **Verification, not trust.** Uploads carry `(seed, moves)`; the API
  re-simulates and derives score, board and hash. Forged scores are rejected.
* **Two handles.** For server games the `gameId` is the *control capability*
  (needed to move); the `replayCode` is the *public* handle for spectating and
  sharing. Live listings and live replays never reveal `gameId`, which is what
  lets MCP's `make_move({gameId, move})` stay stateless without a token.
* **Caching.** The app shell is precached by a service worker; finished
  replays are immutable (`Cache-Control: immutable`, edge cache + SW
  cache-first + IndexedDB), so a replay viewed once works offline forever.
