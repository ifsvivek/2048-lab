-- Analytics & insights (docs/adr/0004-analytics.md).
--
-- Principle: dashboards never scan `games`. Every metric is served from small
-- aggregate tables that are updated incrementally when a game finishes (one
-- D1 batch) or once per day by the cron trigger. Percentiles come from
-- log-scale histograms (4 bins per doubling ≈ ±9% resolution), so they stay
-- O(bins) no matter how many games exist.

-- Exact moments per day/kind: min, max, Σx, Σx² → mean, std-dev; move stats.
ALTER TABLE stats_daily ADD COLUMN min_score INTEGER;
ALTER TABLE stats_daily ADD COLUMN total_score_sq REAL NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN min_moves INTEGER;
ALTER TABLE stats_daily ADD COLUMN max_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN moves_up INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN moves_down INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN moves_left INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN moves_right INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN timed_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN total_time_us INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN total_duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_daily ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;   -- status 'over' (vs abandoned)

-- Histograms: metric in ('score', 'moves'); bin = floor(4 * log2(x + 1)).
CREATE TABLE hist_daily (
  day         TEXT NOT NULL,
  player_kind TEXT NOT NULL,
  metric      TEXT NOT NULL,
  bin         INTEGER NOT NULL,
  n           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, player_kind, metric, bin)
) WITHOUT ROWID;

-- Per-agent aggregates for every agent identity: registered agents (agent_key =
-- their ID), built-ins ("builtin/…") and unregistered named agents ("name:…").
CREATE TABLE agent_stats (
  agent_key      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT,
  games          INTEGER NOT NULL DEFAULT 0,
  completed      INTEGER NOT NULL DEFAULT 0,
  total_score    INTEGER NOT NULL DEFAULT 0,
  best_score     INTEGER NOT NULL DEFAULT 0,
  best_tile      INTEGER NOT NULL DEFAULT 0,
  total_moves    INTEGER NOT NULL DEFAULT 0,
  timed_moves    INTEGER NOT NULL DEFAULT 0,
  total_time_us  INTEGER NOT NULL DEFAULT 0,
  depth_samples  INTEGER NOT NULL DEFAULT 0,
  total_depth    INTEGER NOT NULL DEFAULT 0,
  r2048 INTEGER NOT NULL DEFAULT 0, r4096 INTEGER NOT NULL DEFAULT 0, r8192 INTEGER NOT NULL DEFAULT 0,
  r16384 INTEGER NOT NULL DEFAULT 0, r32768 INTEGER NOT NULL DEFAULT 0, r65536 INTEGER NOT NULL DEFAULT 0,
  last_at        INTEGER
);
CREATE INDEX agent_stats_best ON agent_stats (best_score DESC);

CREATE TABLE agent_hist (
  agent_key TEXT NOT NULL,
  bin       INTEGER NOT NULL,
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_key, bin)
) WITHOUT ROWID;

-- Anonymous players: a random ID generated in the browser (no PII, no IP).
CREATE TABLE players (
  id          TEXT PRIMARY KEY,
  first_day   TEXT NOT NULL,
  last_day    TEXT NOT NULL,
  games       INTEGER NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  best_score  INTEGER NOT NULL DEFAULT 0,
  best_tile   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX players_first_day ON players (first_day);

CREATE TABLE player_days (
  day       TEXT NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (day, player_id)
) WITHOUT ROWID;

-- Browser sessions (random per-tab ID): length = last_at - started_at.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL,
  day        TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL,
  games      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_day ON sessions (day);

-- Named daily counters: replay_views, games_started, page_views, beacons, …
CREATE TABLE counters_daily (
  day   TEXT NOT NULL,
  name  TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
) WITHOUT ROWID;

-- Aggregated dimensions only: dim in ('country', 'device', 'browser', 'os').
CREATE TABLE dims_daily (
  day   TEXT NOT NULL,
  dim   TEXT NOT NULL,
  value TEXT NOT NULL,
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim, value)
) WITHOUT ROWID;

-- Written by the daily cron from player_days / players (indexed, bounded scans).
CREATE TABLE player_daily (
  day       TEXT PRIMARY KEY,
  active    INTEGER NOT NULL,
  new_players       INTEGER NOT NULL,
  returning_players INTEGER NOT NULL,
  sessions  INTEGER NOT NULL DEFAULT 0,
  avg_session_ms REAL
);

CREATE TABLE retention (
  cohort_day TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  d1         INTEGER,            -- NULL until the day has elapsed
  d7         INTEGER,
  d30        INTEGER,
  computed_at INTEGER NOT NULL
);

-- Game columns for attribution and leaderboards.
ALTER TABLE games ADD COLUMN player_id TEXT;
ALTER TABLE games ADD COLUMN session_id TEXT;
CREATE INDEX games_tile ON games (status, max_tile DESC, score DESC);
CREATE INDEX games_length ON games (status, move_count DESC);

-- Cron outputs that need a full pass over players (computed once per day).
CREATE TABLE analytics_snapshot (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,      -- JSON
  computed_at INTEGER NOT NULL
);
