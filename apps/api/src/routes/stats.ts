/** /v1/leaderboard and /v1/stats — read-mostly, edge-cached aggregates. */
import { Hono } from 'hono';
import { publicAgent, type AgentRow } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { type AppEnv, edgeCached } from '../lib/http.ts';

export const stats = new Hono<AppEnv>();

stats.get('/leaderboard', (c) =>
  edgeCached(c, 60, async () => {
    const kind = c.req.query('kind') ?? 'all';
    if (!['all', 'human', 'agent'].includes(kind)) throw new ApiError('BAD_REQUEST', 'kind must be all, human or agent');
    const limit = Math.min(Number(c.req.query('limit') ?? 25) || 25, 100);
    const kindFilter = kind === 'all' ? "player_kind IN ('human', 'agent')" : 'player_kind = ?2';
    const stmt = c.env.DB.prepare(
      `SELECT replay_code, score, max_tile, move_count, player_kind, agent_id, agent_name, finished_at FROM games
       WHERE status IN ('over', 'abandoned') AND ${kindFilter} ORDER BY score DESC LIMIT ?1`,
    );
    const [top, agents] = await c.env.DB.batch([
      kind === 'all' ? stmt.bind(limit) : stmt.bind(limit, kind),
      c.env.DB.prepare('SELECT * FROM agents WHERE games_played > 0 ORDER BY best_score DESC LIMIT 25'),
    ]);
    return {
      kind,
      topScores: (top.results as Record<string, unknown>[]).map((r, i) => ({
        rank: i + 1,
        replayCode: r.replay_code,
        score: r.score,
        maxTile: r.max_tile,
        moveCount: r.move_count,
        player: { kind: r.player_kind, agentId: r.agent_id, name: r.agent_name },
        finishedAt: r.finished_at,
      })),
      topAgents: (agents.results as unknown as AgentRow[]).map((a, i) => ({ rank: i + 1, ...publicAgent(a) })),
      generatedAt: Date.now(),
    };
  }),
);

stats.get('/stats', (c) =>
  edgeCached(c, 300, async () => {
    const days = Math.min(Number(c.req.query('days') ?? 30) || 30, 365);
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const [daily, totals, live, runs] = await c.env.DB.batch([
      c.env.DB.prepare('SELECT * FROM stats_daily WHERE day >= ?1 ORDER BY day ASC').bind(since),
      c.env.DB.prepare(
        `SELECT player_kind, SUM(games) AS games, SUM(total_score) AS total_score, SUM(total_moves) AS total_moves, MAX(best_score) AS best_score,
                MAX(best_tile) AS best_tile, SUM(r2048) AS r2048, SUM(r4096) AS r4096, SUM(r8192) AS r8192, SUM(r16384) AS r16384,
                SUM(r32768) AS r32768, SUM(r65536) AS r65536
         FROM stats_daily GROUP BY player_kind`,
      ),
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'live'"),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM benchmark_runs'),
    ]);
    const byKind: Record<string, unknown> = {};
    for (const t of totals.results as Record<string, number>[]) {
      const g = t.games || 0;
      byKind[t.player_kind as unknown as string] = {
        games: g,
        totalMoves: t.total_moves,
        avgScore: g ? Math.round(t.total_score / g) : 0,
        bestScore: t.best_score,
        bestTile: t.best_tile,
        reachRates: Object.fromEntries([2048, 4096, 8192, 16384, 32768, 65536].map((tile) => [tile, g ? t[`r${tile}`] / g : 0])),
      };
    }
    return {
      totals: byKind,
      liveGames: (live.results[0] as { n: number }).n,
      benchmarkRuns: (runs.results[0] as { n: number }).n,
      daily: daily.results,
      generatedAt: Date.now(),
    };
  }),
);
