-- 2048 platform schema v1 (Cloudflare D1 / SQLite).
-- Write-cost notes (free tier: 100k rows written/day):
--   * a game is ONE row, inserted when it starts on the server (live) or when a
--     finished local game is uploaded, and updated once when it finishes.
--   * moves are never written per-move to D1; live games buffer them in their
--     Durable Object and flush once.
--   * aggregate stats are maintained by one upsert per finished game into
--     stats_daily (instead of scanning games), so dashboards read O(days) rows.

CREATE TABLE games (
  id            TEXT PRIMARY KEY,               -- ULID; private control handle while live
  replay_code   TEXT NOT NULL UNIQUE,           -- public share/spectate handle, e.g. A7KF-29LM-XQ4P
  status        TEXT NOT NULL CHECK (status IN ('live', 'over', 'abandoned')),
  source        TEXT NOT NULL,                  -- web | api | mcp | driver | upload
  spec_version  INTEGER NOT NULL,
  seed          INTEGER NOT NULL,
  moves         TEXT NOT NULL DEFAULT '',       -- one letter per valid move (UDLR)
  timing        TEXT,                           -- JSON int[] µs per decision, optional
  score         INTEGER NOT NULL DEFAULT 0,
  max_tile      INTEGER NOT NULL DEFAULT 0,
  move_count    INTEGER NOT NULL DEFAULT 0,
  final_board   TEXT,                           -- boardHex
  history_hash  TEXT,
  player_kind   TEXT NOT NULL CHECK (player_kind IN ('human', 'agent')),
  agent_id      TEXT,
  agent_name    TEXT,
  agent_version TEXT,
  agent_config  TEXT,                           -- JSON
  runtime       TEXT,                           -- JSON {language, runtime, version, platform}
  started_at    INTEGER NOT NULL,               -- epoch ms
  finished_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX games_leaderboard ON games (status, player_kind, score DESC);
CREATE INDEX games_agent ON games (agent_id, score DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX games_live ON games (status, started_at DESC) WHERE status = 'live';

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,               -- ULID
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,                  -- remote | worker | llm | search | rl | other
  language      TEXT,
  runtime       TEXT,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  description   TEXT,
  endpoint      TEXT,                           -- push-mode POST /decide URL (optional)
  key_hash      TEXT NOT NULL,                  -- SHA-256 of the API key
  games_played  INTEGER NOT NULL DEFAULT 0,
  total_score   INTEGER NOT NULL DEFAULT 0,
  best_score    INTEGER NOT NULL DEFAULT 0,
  best_tile     INTEGER NOT NULL DEFAULT 0,
  total_moves   INTEGER NOT NULL DEFAULT 0,
  reached       TEXT NOT NULL DEFAULT '{}',     -- JSON {"2048": n, ...}
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX agents_best ON agents (best_score DESC);

CREATE TABLE benchmark_runs (
  id               TEXT PRIMARY KEY,            -- ULID
  source           TEXT NOT NULL,               -- runner | browser | server
  status           TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('running', 'complete', 'failed')),
  suite_id         TEXT NOT NULL,
  spec_version     INTEGER NOT NULL,
  language         TEXT NOT NULL,
  runtime          TEXT NOT NULL,
  runtime_version  TEXT,
  platform         TEXT,
  agent_id         TEXT NOT NULL,
  agent_config     TEXT,
  environment      TEXT,                        -- JSON
  deterministic    INTEGER NOT NULL,
  verified         INTEGER NOT NULL DEFAULT 0,  -- checksum matched the reference fixture
  checksum         TEXT,
  games            INTEGER NOT NULL,
  avg_score        REAL,
  max_score        INTEGER,
  max_tile         INTEGER,
  total_moves      INTEGER,
  wall_ms          REAL,
  cpu_ms           REAL,
  games_per_sec    REAL,
  moves_per_sec    REAL,
  nodes_per_sec    REAL,
  avg_decision_us  REAL,
  p99_decision_us  REAL,
  peak_memory      INTEGER,
  summary          TEXT NOT NULL,               -- full summary JSON
  results          TEXT,                        -- compact per-game JSON
  created_at       INTEGER NOT NULL
);
CREATE INDEX benchmark_suite ON benchmark_runs (suite_id, language, created_at DESC);
CREATE INDEX benchmark_recent ON benchmark_runs (created_at DESC);

CREATE TABLE stats_daily (
  day           TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  player_kind   TEXT NOT NULL,
  games         INTEGER NOT NULL DEFAULT 0,
  total_score   INTEGER NOT NULL DEFAULT 0,
  total_moves   INTEGER NOT NULL DEFAULT 0,
  best_score    INTEGER NOT NULL DEFAULT 0,
  best_tile     INTEGER NOT NULL DEFAULT 0,
  r2048         INTEGER NOT NULL DEFAULT 0,
  r4096         INTEGER NOT NULL DEFAULT 0,
  r8192         INTEGER NOT NULL DEFAULT 0,
  r16384        INTEGER NOT NULL DEFAULT 0,
  r32768        INTEGER NOT NULL DEFAULT 0,
  r65536        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, player_kind)
);
