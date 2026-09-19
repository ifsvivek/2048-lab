/**
 * Incremental analytics. `analyticsStatements` returns the statements that fold
 * one finished game into every aggregate; callers add them to the same
 * `DB.batch()` as the game write, so a finished game costs one round trip.
 *
 * Rows written per finished game (free tier budget: 100k rows/day):
 *   stats_daily 1 · hist_daily 4 (daily + all-time, score + moves) · agent_stats 1 + agent_hist 1 (agents only)
 *   players 1 + player_days ≤1 + sessions 1 (browser games only)
 */
import type { GameRecord } from './db.ts';

export const REACH = [2048, 4096, 8192, 16384, 32768, 65536] as const;

/** Log-scale histogram: 4 bins per doubling. */
export const histBin = (x: number): number => Math.floor(4 * Math.log2(Math.max(0, x) + 1));
export const binLow = (b: number): number => 2 ** (b / 4) - 1;
export const binHigh = (b: number): number => 2 ** ((b + 1) / 4) - 1;

export interface Hist {
  bin: number;
  n: number;
}

/** Percentile from a histogram, interpolating geometrically inside the bin. */
export function histPercentile(h: Hist[], p: number): number | null {
  const bins = [...h].sort((a, b) => a.bin - b.bin);
  const total = bins.reduce((a, b) => a + b.n, 0);
  if (!total) return null;
  const target = p * total;
  let acc = 0;
  for (const { bin, n } of bins) {
    if (acc + n >= target) {
      const frac = n ? (target - acc) / n : 0;
      const lo = Math.log2(binLow(bin) + 1);
      const hi = Math.log2(binHigh(bin) + 1);
      return Math.round(2 ** (lo + frac * (hi - lo)) - 1);
    }
    acc += n;
  }
  return Math.round(binHigh(bins[bins.length - 1].bin));
}

export const PERCENTILES = [0.5, 0.75, 0.9, 0.95, 0.99, 0.999] as const;
export const percentileKey = (p: number) => `p${String(p * 100).replace('.', '_')}`;

export function percentiles(h: Hist[]): Record<string, number | null> {
  return Object.fromEntries(PERCENTILES.map((p) => [percentileKey(p), histPercentile(h, p)]));
}

/** Extra per-game facts collected alongside a GameRecord. */
export interface GameFacts {
  playerId?: string | null;
  sessionId?: string | null;
  agentKind?: string | null;
  depthSum?: number;
  depthSamples?: number;
}

export function agentKey(g: GameRecord): string | null {
  if (g.agentId) return g.agentId;
  if (g.playerKind === 'agent' && g.agentName) return `name:${g.agentName.slice(0, 64)}`;
  return null;
}

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function analyticsStatements(db: D1Database, g: GameRecord, f: GameFacts = {}): D1PreparedStatement[] {
  const finished = g.finishedAt ?? Date.now();
  const day = dayOf(finished);
  const r = REACH.map((t) => (g.maxTile >= t ? 1 : 0));
  const dirs = [0, 0, 0, 0];
  for (let i = 0; i < g.moves.length; i++) dirs['UDLR'.indexOf(g.moves[i])]++;
  const timed = g.timing ? g.timing.filter((t) => t > 0) : [];
  const timeUs = timed.reduce((a, b) => a + b, 0);
  const completed = g.status === 'over' ? 1 : 0;
  const duration = Math.max(0, finished - g.startedAt);

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO stats_daily (day, player_kind, games, total_score, total_moves, best_score, best_tile,
           r2048, r4096, r8192, r16384, r32768, r65536, min_score, total_score_sq, min_moves, max_moves,
           moves_up, moves_down, moves_left, moves_right, timed_moves, total_time_us, total_duration_ms, completed)
         VALUES (?1, ?2, 1, ?3, ?4, ?3, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?3, ?12, ?4, ?4, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
         ON CONFLICT(day, player_kind) DO UPDATE SET games = games + 1,
           total_score = total_score + excluded.total_score, total_moves = total_moves + excluded.total_moves,
           best_score = MAX(best_score, excluded.best_score), best_tile = MAX(best_tile, excluded.best_tile),
           r2048 = r2048 + excluded.r2048, r4096 = r4096 + excluded.r4096, r8192 = r8192 + excluded.r8192,
           r16384 = r16384 + excluded.r16384, r32768 = r32768 + excluded.r32768, r65536 = r65536 + excluded.r65536,
           min_score = MIN(COALESCE(min_score, excluded.min_score), excluded.min_score),
           total_score_sq = total_score_sq + excluded.total_score_sq,
           min_moves = MIN(COALESCE(min_moves, excluded.min_moves), excluded.min_moves),
           max_moves = MAX(max_moves, excluded.max_moves),
           moves_up = moves_up + excluded.moves_up, moves_down = moves_down + excluded.moves_down,
           moves_left = moves_left + excluded.moves_left, moves_right = moves_right + excluded.moves_right,
           timed_moves = timed_moves + excluded.timed_moves, total_time_us = total_time_us + excluded.total_time_us,
           total_duration_ms = total_duration_ms + excluded.total_duration_ms, completed = completed + excluded.completed`,
      )
      .bind(day, g.playerKind, g.score, g.moveCount, g.maxTile, ...r, g.score * g.score, ...dirs, timed.length, timeUs, duration, completed),
    // Daily bins (trends) + an 'all' row per bin (all-time percentiles in O(bins)).
    ...(['score', 'moves'] as const).flatMap((metric) =>
      [day, 'all'].map((d) =>
        db
          .prepare(
            `INSERT INTO hist_daily (day, player_kind, metric, bin, n) VALUES (?1, ?2, ?3, ?4, 1)
             ON CONFLICT(day, player_kind, metric, bin) DO UPDATE SET n = n + 1`,
          )
          .bind(d, g.playerKind, metric, histBin(metric === 'score' ? g.score : g.moveCount)),
      ),
    ),
  ];

  const key = agentKey(g);
  if (key) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO agent_stats (agent_key, name, kind, games, completed, total_score, best_score, best_tile, total_moves,
             timed_moves, total_time_us, depth_samples, total_depth, r2048, r4096, r8192, r16384, r32768, r65536, last_at)
           VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
           ON CONFLICT(agent_key) DO UPDATE SET games = games + 1, completed = completed + excluded.completed,
             name = excluded.name, kind = COALESCE(excluded.kind, kind),
             total_score = total_score + excluded.total_score, best_score = MAX(best_score, excluded.best_score),
             best_tile = MAX(best_tile, excluded.best_tile), total_moves = total_moves + excluded.total_moves,
             timed_moves = timed_moves + excluded.timed_moves, total_time_us = total_time_us + excluded.total_time_us,
             depth_samples = depth_samples + excluded.depth_samples, total_depth = total_depth + excluded.total_depth,
             r2048 = r2048 + excluded.r2048, r4096 = r4096 + excluded.r4096, r8192 = r8192 + excluded.r8192,
             r16384 = r16384 + excluded.r16384, r32768 = r32768 + excluded.r32768, r65536 = r65536 + excluded.r65536,
             last_at = excluded.last_at`,
        )
        .bind(key, g.agentName ?? key, f.agentKind ?? null, completed, g.score, g.maxTile, g.moveCount, timed.length, timeUs, f.depthSamples ?? 0, f.depthSum ?? 0, ...r, finished),
      db
        .prepare('INSERT INTO agent_hist (agent_key, bin, n) VALUES (?1, ?2, 1) ON CONFLICT(agent_key, bin) DO UPDATE SET n = n + 1')
        .bind(key, histBin(g.score)),
    );
  }

  if (f.playerId) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO players (id, first_day, last_day, games, total_score, best_score, best_tile) VALUES (?1, ?2, ?2, 1, ?3, ?3, ?4)
           ON CONFLICT(id) DO UPDATE SET last_day = excluded.last_day, games = games + 1, total_score = total_score + excluded.total_score,
             best_score = MAX(best_score, excluded.best_score), best_tile = MAX(best_tile, excluded.best_tile)`,
        )
        .bind(f.playerId, day, g.score, g.maxTile),
      db.prepare('INSERT OR IGNORE INTO player_days (day, player_id) VALUES (?1, ?2)').bind(day, f.playerId),
    );
    if (f.sessionId) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO sessions (id, player_id, day, started_at, last_at, games) VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(id) DO UPDATE SET last_at = MAX(last_at, excluded.last_at), started_at = MIN(started_at, excluded.started_at), games = games + 1`,
          )
          .bind(f.sessionId, f.playerId, dayOf(g.startedAt), g.startedAt, finished),
      );
    }
  }
  return stmts;
}

/** Validates the anonymous client identifiers (random 16–40 char tokens). */
export const isClientId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{16,40}$/.test(s);
