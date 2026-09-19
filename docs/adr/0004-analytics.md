# ADR 0004 — Analytics on the free tier

**Status:** accepted

## Decision
Dashboards never scan `games`. Every metric reads small aggregate tables:

| Table | Written | Gives |
|---|---|---|
| `stats_daily` (day × kind) | per finished game | counts, Σscore, Σscore² (exact mean/std-dev), min/max, moves, direction counts, latency, duration, tile reach |
| `hist_daily` (day/`all` × kind × metric × bin) | per finished game | percentiles P50…P99.9 of score and game length, per day and all-time in O(bins) |
| `agent_stats`, `agent_hist` | per finished agent game | per-agent avg/median/P90/P99, decision time, search depth, reach rates |
| `players`, `player_days`, `sessions` | per finished browser game | anonymous player activity |
| `counters_daily`, `dims_daily` | one beacon per browser session | replay views, games started, country/device/browser/OS (aggregated only) |
| `player_daily`, `retention`, `analytics_snapshot` | daily cron | active/new/returning, D1/D7/D30 cohorts, per-player aggregates |

* **Histogram percentiles**: bin = ⌊4·log₂(x+1)⌋ (≈19 % wide), linear
  interpolation inside the bin, clamped to the exact min/max → documented as
  approximate (≈) in the UI; mean, min, max and std-dev are exact.
* **Write budget**: ~7 rows per finished game (+2 for agent games, +3 for
  browser games with a player ID), never per move. Rollups ride in the same
  D1 batch as the game row.
* **Reads**: every endpoint is edge-cached 2–10 min; the heaviest query reads
  O(days × bins) rows.
* **Privacy**: players are random browser tokens; no IPs, no fingerprints.
  Country comes from Cloudflare's request metadata and is only ever counted.
