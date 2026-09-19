-- LLM token / cost usage, self-reported by LLM-backed agents (MCP `report_usage`,
-- REST POST /v1/games/{id}/usage). One row per game holding cumulative totals;
-- re-reporting replaces the row (idempotent). The platform cannot observe a
-- client's tokens, so rows are labelled self-reported; cost is either supplied
-- by the client (e.g. OpenRouter usage accounting) or estimated from a price table.
CREATE TABLE llm_usage (
  game_id            TEXT PRIMARY KEY,
  day                TEXT NOT NULL,            -- UTC day of the latest report
  provider           TEXT,                     -- anthropic | openrouter | openai | google | other
  model              TEXT NOT NULL,
  agent_name         TEXT,
  source             TEXT NOT NULL,            -- mcp | api
  calls              INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,                     -- NULL = unknown (unpriced model, no client figure)
  cost_estimated     INTEGER NOT NULL DEFAULT 0,
  reported_at        INTEGER NOT NULL
);
CREATE INDEX llm_usage_model ON llm_usage (model);
CREATE INDEX llm_usage_day ON llm_usage (day);
