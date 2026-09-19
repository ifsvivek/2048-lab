/**
 * /v1/analytics — every endpoint reads aggregate tables only (never `games`,
 * except index-ordered LIMIT queries for leaderboards) and is edge-cached.
 */
import { Hono } from 'hono';
import { type Hist, REACH, binHigh, binLow, clampTo, histPercentile, isClientId, percentiles } from '../lib/analytics.ts';
import { ApiError } from '../lib/errors.ts';
import { type AppEnv, type Ctx, body, edgeCached, rateLimit } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { type UsageRow, usageOut } from '../lib/usage.ts';
import { IMPACT_ASSUMPTIONS, equivalents, footprint, sumFootprints } from '../lib/impact.ts';

export const analytics = new Hono<AppEnv>();

type Kind = 'all' | 'human' | 'agent';
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

function kindOf(c: Ctx): Kind {
  const k = c.req.query('kind') ?? 'all';
  if (k !== 'all' && k !== 'human' && k !== 'agent') throw new ApiError('BAD_REQUEST', 'kind must be all, human or agent');
  return k;
}
const kindSql = (k: Kind, col = 'player_kind') => (k === 'all' ? '1 = 1' : `${col} = '${k}'`);
const clampDays = (c: Ctx, dflt: number) => Math.min(Math.max(Number(c.req.query('days') ?? dflt) || dflt, 1), 730);

/** Period bucket for trend series. */
function bucket(day: string, g: 'day' | 'week' | 'month'): string {
  if (g === 'day') return day;
  if (g === 'month') return day.slice(0, 7);
  const d = new Date(day + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Monday-based ISO week
  return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}

interface StatsRow {
  day: string;
  player_kind: string;
  games: number;
  completed: number;
  total_score: number;
  total_score_sq: number;
  best_score: number;
  min_score: number | null;
  best_tile: number;
  total_moves: number;
  min_moves: number | null;
  max_moves: number;
  moves_up: number;
  moves_down: number;
  moves_left: number;
  moves_right: number;
  timed_moves: number;
  total_time_us: number;
  total_duration_ms: number;
  [k: `r${number}`]: number;
}

/** Fold stats_daily rows into exact moments. */
function fold(rows: StatsRow[]) {
  const z = { games: 0, completed: 0, sum: 0, sumSq: 0, max: 0, min: null as number | null, bestTile: 0, moves: 0, minMoves: null as number | null, maxMoves: 0, dirs: [0, 0, 0, 0], timed: 0, timeUs: 0, durationMs: 0, reach: Object.fromEntries(REACH.map((t) => [t, 0])) as Record<number, number> };
  for (const r of rows) {
    z.games += r.games;
    z.completed += r.completed ?? 0;
    z.sum += r.total_score;
    z.sumSq += r.total_score_sq ?? 0;
    z.max = Math.max(z.max, r.best_score);
    if (r.min_score !== null && r.min_score !== undefined) z.min = z.min === null ? r.min_score : Math.min(z.min, r.min_score);
    z.bestTile = Math.max(z.bestTile, r.best_tile);
    z.moves += r.total_moves;
    if (r.min_moves !== null && r.min_moves !== undefined) z.minMoves = z.minMoves === null ? r.min_moves : Math.min(z.minMoves, r.min_moves);
    z.maxMoves = Math.max(z.maxMoves, r.max_moves ?? 0);
    z.dirs[0] += r.moves_up ?? 0;
    z.dirs[1] += r.moves_down ?? 0;
    z.dirs[2] += r.moves_left ?? 0;
    z.dirs[3] += r.moves_right ?? 0;
    z.timed += r.timed_moves ?? 0;
    z.timeUs += r.total_time_us ?? 0;
    z.durationMs += r.total_duration_ms ?? 0;
    for (const t of REACH) z.reach[t] += r[`r${t}`] ?? 0;
  }
  const mean = z.games ? z.sum / z.games : null;
  const variance = z.games && mean !== null ? Math.max(0, z.sumSq / z.games - mean * mean) : null;
  return {
    games: z.games,
    completed: z.completed,
    totalScore: z.sum,
    avgScore: mean,
    stdDev: variance === null ? null : Math.sqrt(variance),
    maxScore: z.games ? z.max : null,
    minScore: z.min,
    bestTile: z.bestTile,
    totalMoves: z.moves,
    avgMoves: z.games ? z.moves / z.games : null,
    shortestGame: z.minMoves,
    longestGame: z.games ? z.maxMoves : null,
    moveFrequency: { up: z.dirs[0], down: z.dirs[1], left: z.dirs[2], right: z.dirs[3] },
    avgMoveLatencyUs: z.timed ? z.timeUs / z.timed : null,
    avgGameDurationMs: z.games ? z.durationMs / z.games : null,
    reach: Object.fromEntries(REACH.map((t) => [t, { games: z.reach[t], rate: z.games ? z.reach[t] / z.games : 0 }])),
  };
}

async function statsRows(c: Ctx, kind: Kind, since?: string): Promise<StatsRow[]> {
  const where = [kindSql(kind)];
  const args: string[] = [];
  if (since) {
    args.push(since);
    where.push(`day >= ?${args.length}`);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM stats_daily WHERE ${where.join(' AND ')}`).bind(...args).all<StatsRow>();
  return results;
}

async function allTimeHist(c: Ctx, kind: Kind, metric: 'score' | 'moves'): Promise<Hist[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT bin, SUM(n) AS n FROM hist_daily WHERE day = 'all' AND metric = ?1 AND ${kindSql(kind)} GROUP BY bin`,
  )
    .bind(metric)
    .all<Hist>();
  return results;
}

const histOut = (h: Hist[]) =>
  [...h].sort((a, b) => a.bin - b.bin).map(({ bin, n }) => ({ bin, from: Math.round(binLow(bin)), to: Math.round(binHigh(bin)), n }));

async function snapshot<T>(c: Ctx, key: string): Promise<(T & { computedAt: number }) | null> {
  const r = await c.env.DB.prepare('SELECT value, computed_at FROM analytics_snapshot WHERE key = ?1').bind(key).first<{ value: string; computed_at: number }>();
  return r ? { ...(JSON.parse(r.value) as T), computedAt: r.computed_at } : null;
}

async function counterTotals(c: Ctx, since?: string): Promise<Record<string, number>> {
  const { results } = await c.env.DB.prepare(`SELECT name, SUM(value) AS v FROM counters_daily ${since ? 'WHERE day >= ?1' : ''} GROUP BY name`)
    .bind(...(since ? [since] : []))
    .all<{ name: string; v: number }>();
  return Object.fromEntries(results.map((r) => [r.name, r.v]));
}

// ------------------------------------------------------------- executive

analytics.get('/overview', (c) =>
  edgeCached(c, 120, async () => {
    const [rows, scoreHist, counters, snap, live, runs, agentsCount, topAgent, runtimes, newToday] = await Promise.all([
      statsRows(c, 'all'),
      allTimeHist(c, 'all', 'score'),
      counterTotals(c),
      snapshot<Record<string, number>>(c, 'players'),
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'live'").first<{ n: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM benchmark_runs').first<{ n: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM agents').first<{ n: number }>(),
      c.env.DB.prepare('SELECT agent_key, name, games, total_score, best_score FROM agent_stats WHERE games >= 3 ORDER BY CAST(total_score AS REAL) / games DESC LIMIT 1').first<Record<string, number | string>>(),
      c.env.DB.prepare(
        `SELECT language, runtime, MAX(moves_per_sec) AS mps FROM benchmark_runs
         WHERE suite_id = 'expectimax-d2-10' AND status = 'complete' AND verified = 1 GROUP BY language, runtime ORDER BY mps DESC LIMIT 1`,
      ).first<{ language: string; runtime: string; mps: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE first_day = ?1').bind(today()).first<{ n: number }>(),
    ]);
    const all = fold(rows);
    const recent = fold(rows.filter((r) => r.day >= daysAgo(6)));
    const byDay = new Map<string, number>();
    for (const r of rows) if (r.day >= daysAgo(29)) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.games);
    const spark = Array.from({ length: 30 }, (_, i) => {
      const d = daysAgo(29 - i);
      return { day: d, games: byDay.get(d) ?? 0 };
    });
    return {
      totals: {
        games: all.games,
        gamesStarted: counters.games_started ?? 0,
        completedGames: all.completed,
        activeGames: live?.n ?? 0,
        players: (snap?.players ?? 0) + (snap && new Date(snap.computedAt).toISOString().slice(0, 10) === today() ? 0 : newToday?.n ?? 0),
        totalMoves: all.totalMoves,
        avgMovesPerGame: all.avgMoves,
        avgScore: all.avgScore,
        highestScore: all.maxScore,
        p99Score: clampTo(histPercentile(scoreHist, 0.99), all.minScore, all.maxScore),
        replayViews: counters.replay_views ?? 0,
        benchmarkRuns: runs?.n ?? 0,
        registeredAgents: agentsCount?.n ?? 0,
      },
      last7Days: { games: recent.games, avgScore: recent.avgScore, totalMoves: recent.totalMoves },
      topAgent: topAgent ? { key: topAgent.agent_key, name: topAgent.name, games: topAgent.games, avgScore: Number(topAgent.total_score) / Number(topAgent.games), bestScore: topAgent.best_score } : null,
      topRuntime: runtimes ? { language: runtimes.language, runtime: runtimes.runtime, movesPerSec: runtimes.mps, suite: 'expectimax-d2-10' } : null,
      sparkline: spark,
      generatedAt: Date.now(),
    };
  }),
);

// -------------------------------------------------------------- platform

analytics.get('/platform', (c) =>
  edgeCached(c, 300, async () => {
    const g = (c.req.query('granularity') ?? 'day') as 'day' | 'week' | 'month';
    if (!['day', 'week', 'month'].includes(g)) throw new ApiError('BAD_REQUEST', 'granularity must be day, week or month');
    const days = clampDays(c, g === 'day' ? 30 : g === 'week' ? 182 : 365);
    const since = daysAgo(days - 1);
    const [rows, counters, players, runs, agents] = await Promise.all([
      statsRows(c, 'all', since),
      c.env.DB.prepare('SELECT day, name, value FROM counters_daily WHERE day >= ?1').bind(since).all<{ day: string; name: string; value: number }>(),
      c.env.DB.prepare('SELECT * FROM player_daily WHERE day >= ?1').bind(since).all<{ day: string; active: number; new_players: number; returning_players: number }>(),
      c.env.DB.prepare("SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM benchmark_runs WHERE created_at >= ?1 GROUP BY day").bind(Date.parse(since)).all<{ day: string; n: number }>(),
      c.env.DB.prepare("SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM agents WHERE created_at >= ?1 GROUP BY day").bind(Date.parse(since)).all<{ day: string; n: number }>(),
    ]);
    const series = new Map<string, Record<string, number>>();
    const at = (day: string) => {
      const k = bucket(day, g);
      if (!series.has(k)) series.set(k, { games: 0, completed: 0, moves: 0, replayViews: 0, gamesStarted: 0, benchmarkRuns: 0, newAgents: 0, activePlayers: 0, newPlayers: 0, returningPlayers: 0 });
      return series.get(k)!;
    };
    for (let i = days - 1; i >= 0; i--) at(daysAgo(i));
    for (const r of rows) {
      const s = at(r.day);
      s.games += r.games;
      s.completed += r.completed ?? 0;
      s.moves += r.total_moves;
    }
    for (const r of counters.results) {
      const s = at(r.day);
      if (r.name === 'replay_views') s.replayViews += r.value;
      if (r.name === 'games_started') s.gamesStarted += r.value;
    }
    for (const r of players.results) {
      const s = at(r.day);
      s.activePlayers += r.active; // for week/month this is player-days, labelled as such by the client
      s.newPlayers += r.new_players;
      s.returningPlayers += r.returning_players;
    }
    for (const r of runs.results) at(r.day).benchmarkRuns += r.n;
    for (const r of agents.results) at(r.day).newAgents += r.n;
    const out = [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, s]) => ({ period, ...s, avgMoves: s.games ? s.moves / s.games : null }));
    const totals = fold(await statsRows(c, 'all'));
    const counterAll = await counterTotals(c);
    return {
      granularity: g,
      days,
      series: out,
      allTime: { games: totals.games, completed: totals.completed, totalMoves: totals.totalMoves, avgMovesPerGame: totals.avgMoves, replayViews: counterAll.replay_views ?? 0, gamesStarted: counterAll.games_started ?? 0 },
    };
  }),
);

// --------------------------------------------------------------- players

analytics.get('/players', (c) =>
  edgeCached(c, 600, async () => {
    const [snap, daily, retention, sessions] = await Promise.all([
      snapshot<Record<string, number>>(c, 'players'),
      c.env.DB.prepare('SELECT * FROM player_daily WHERE day >= ?1 ORDER BY day').bind(daysAgo(89)).all(),
      c.env.DB.prepare('SELECT * FROM retention ORDER BY cohort_day DESC LIMIT 31').all<{ cohort_day: string; size: number; d1: number | null; d7: number | null; d30: number | null }>(),
      c.env.DB.prepare('SELECT SUM(sessions) AS n, SUM(avg_session_ms * sessions) / NULLIF(SUM(sessions), 0) AS avg FROM player_daily WHERE day >= ?1').bind(daysAgo(29)).first<{ n: number; avg: number | null }>(),
    ]);
    // Retention = retained / cohort size, over cohorts old enough for each horizon.
    const rate = (key: 'd1' | 'd7' | 'd30') => {
      const rs = retention.results.filter((r) => r[key] !== null);
      const size = rs.reduce((a, r) => a + r.size, 0);
      return size >= 5 ? { rate: rs.reduce((a, r) => a + (r[key] ?? 0), 0) / size, cohortPlayers: size } : { rate: null, cohortPlayers: size };
    };
    const last30 = (daily.results as { day: string; active: number; new_players: number; returning_players: number }[]).filter((d) => d.day >= daysAgo(29));
    return {
      uniquePlayers: snap?.players ?? 0,
      newPlayers30d: last30.reduce((a, d) => a + d.new_players, 0),
      returningPlayerDays30d: last30.reduce((a, d) => a + d.returning_players, 0),
      gamesPerPlayer: snap?.avg_games ?? null,
      avgScorePerPlayer: snap?.avg_player_score ?? null,
      avgHighestScorePerPlayer: snap?.avg_best_score ?? null,
      highestScorePerPlayer: snap?.best_score ?? null,
      playersWithMultipleGames: snap?.multi_game ?? 0,
      avgSessionMs: sessions?.avg ?? null,
      sessions30d: sessions?.n ?? 0,
      retention: { d1: rate('d1'), d7: rate('d7'), d30: rate('d30') },
      cohorts: retention.results,
      daily: daily.results,
      snapshotAt: snap?.computedAt ?? null,
      note: 'Players are anonymous browser IDs; per-player aggregates refresh daily.',
    };
  }),
);

// ---------------------------------------------------------------- scores

analytics.get('/scores', (c) =>
  edgeCached(c, 300, async () => {
    const kind = kindOf(c);
    const days = clampDays(c, 60);
    const since = daysAgo(days - 1);
    const [rows, hist, dailyHist] = await Promise.all([
      statsRows(c, kind),
      allTimeHist(c, kind, 'score'),
      c.env.DB.prepare(`SELECT day, bin, SUM(n) AS n FROM hist_daily WHERE metric = 'score' AND day != 'all' AND day >= ?1 AND ${kindSql(kind)} GROUP BY day, bin`)
        .bind(since)
        .all<{ day: string; bin: number; n: number }>(),
    ]);
    const all = fold(rows);
    const byDay = new Map<string, Hist[]>();
    for (const r of dailyHist.results) {
      if (!byDay.has(r.day)) byDay.set(r.day, []);
      byDay.get(r.day)!.push({ bin: r.bin, n: r.n });
    }
    const statsByDay = new Map<string, StatsRow[]>();
    for (const r of rows) if (r.day >= since) (statsByDay.get(r.day) ?? statsByDay.set(r.day, []).get(r.day)!).push(r);
    const trend = [...byDay.keys()].sort().map((day) => {
      const f = fold(statsByDay.get(day) ?? []);
      return { day, games: f.games, avg: f.avgScore, max: f.maxScore, ...percentiles(byDay.get(day)!, f.minScore, f.maxScore) };
    });
    return {
      kind,
      summary: { games: all.games, avg: all.avgScore, median: clampTo(histPercentile(hist, 0.5), all.minScore, all.maxScore), max: all.maxScore, min: all.minScore, stdDev: all.stdDev, ...percentiles(hist, all.minScore, all.maxScore) },
      histogram: histOut(hist),
      trend,
      note: 'Mean, min, max and std-dev are exact; percentiles come from log-scale histograms (±9% bin resolution).',
    };
  }),
);

// ----------------------------------------------------------------- tiles

analytics.get('/tiles', (c) =>
  edgeCached(c, 300, async () => {
    const [human, agent, snap] = await Promise.all([statsRows(c, 'human'), statsRows(c, 'agent'), snapshot<Record<string, number>>(c, 'players')]);
    const h = fold(human);
    const a = fold(agent);
    const all = fold([...human, ...agent]);
    return {
      tiles: REACH.map((t) => ({
        tile: t,
        games: all.reach[t].games,
        gameRate: all.reach[t].rate,
        humanRate: h.reach[t].rate,
        agentRate: a.reach[t].rate,
        players: snap?.[`r${t}`] ?? 0,
        playerRate: snap?.players ? (snap[`r${t}`] ?? 0) / snap.players : null,
      })),
      games: { all: all.games, human: h.games, agent: a.games },
      bestTile: all.bestTile,
    };
  }),
);

// ----------------------------------------------------------------- moves

analytics.get('/moves', (c) =>
  edgeCached(c, 300, async () => {
    const out: Record<string, unknown> = {};
    for (const kind of ['human', 'agent', 'all'] as const) {
      const [rows, hist] = await Promise.all([statsRows(c, kind), allTimeHist(c, kind, 'moves')]);
      const f = fold(rows);
      out[kind] = {
        games: f.games,
        avgMoves: f.avgMoves,
        medianMoves: clampTo(histPercentile(hist, 0.5), f.shortestGame, f.longestGame),
        longestGame: f.longestGame,
        shortestGame: f.shortestGame,
        frequency: f.moveFrequency,
        avgLatencyUs: f.avgMoveLatencyUs,
        avgGameDurationMs: f.avgGameDurationMs,
        histogram: histOut(hist),
      };
    }
    return out;
  }),
);

// ---------------------------------------------------------------- agents

interface AgentStatRow {
  agent_key: string;
  name: string;
  kind: string | null;
  games: number;
  completed: number;
  total_score: number;
  best_score: number;
  best_tile: number;
  total_moves: number;
  timed_moves: number;
  total_time_us: number;
  depth_samples: number;
  total_depth: number;
  last_at: number;
  [k: `r${number}`]: number;
}

function agentOut(a: AgentStatRow, hist: Hist[]) {
  return {
    key: a.agent_key,
    name: a.name,
    kind: a.kind,
    games: a.games,
    completed: a.completed,
    avgScore: a.games ? a.total_score / a.games : null,
    maxScore: a.best_score,
    medianScore: clampTo(histPercentile(hist, 0.5), null, a.best_score),
    p90Score: clampTo(histPercentile(hist, 0.9), null, a.best_score),
    p99Score: clampTo(histPercentile(hist, 0.99), null, a.best_score),
    highestTile: a.best_tile,
    avgMoves: a.games ? a.total_moves / a.games : null,
    avgDecisionUs: a.timed_moves ? a.total_time_us / a.timed_moves : null,
    avgDepth: a.depth_samples ? a.total_depth / a.depth_samples : null,
    reachRates: Object.fromEntries(REACH.map((t) => [t, a.games ? (a[`r${t}`] ?? 0) / a.games : 0])),
    lastPlayedAt: a.last_at,
  };
}

async function agentList(c: Ctx, limit: number) {
  const { results } = await c.env.DB.prepare('SELECT * FROM agent_stats ORDER BY games DESC LIMIT ?1').bind(limit).all<AgentStatRow>();
  if (!results.length) return [];
  const keys = results.map((r) => r.agent_key);
  const hist = await c.env.DB.prepare(`SELECT agent_key, bin, n FROM agent_hist WHERE agent_key IN (${keys.map((_, i) => `?${i + 1}`).join(',')})`)
    .bind(...keys)
    .all<{ agent_key: string; bin: number; n: number }>();
  const byKey = new Map<string, Hist[]>();
  for (const h of hist.results) (byKey.get(h.agent_key) ?? byKey.set(h.agent_key, []).get(h.agent_key)!).push(h);
  return results.map((a) => agentOut(a, byKey.get(a.agent_key) ?? []));
}

analytics.get('/agents', (c) => edgeCached(c, 300, async () => ({ agents: await agentList(c, Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)) })));

analytics.get('/agents/:key{.+}', (c) =>
  edgeCached(c, 300, async () => {
    const key = decodeURIComponent(c.req.param('key'));
    const a = await c.env.DB.prepare('SELECT * FROM agent_stats WHERE agent_key = ?1 OR name = ?1 ORDER BY games DESC LIMIT 1').bind(key).first<AgentStatRow>();
    if (!a) throw new ApiError('AGENT_NOT_FOUND', `no games recorded for agent '${key}'`);
    const hist = await c.env.DB.prepare('SELECT bin, n FROM agent_hist WHERE agent_key = ?1').bind(a.agent_key).all<Hist>();
    return { ...agentOut(a, hist.results), histogram: histOut(hist.results) };
  }),
);

// ------------------------------------------------------------ benchmarks

interface RunRow {
  suite_id: string;
  language: string;
  runtime: string;
  moves_per_sec: number | null;
  games_per_sec: number | null;
  nodes_per_sec: number | null;
  avg_decision_us: number | null;
  peak_memory: number | null;
  avg_score: number | null;
  verified: number;
  created_at: number;
}

async function runsBySuite(c: Ctx) {
  const { results } = await c.env.DB.prepare(
    `SELECT suite_id, language, runtime, moves_per_sec, games_per_sec, nodes_per_sec, avg_decision_us, peak_memory, avg_score, verified, created_at
     FROM benchmark_runs WHERE status = 'complete' ORDER BY created_at DESC LIMIT 2000`,
  ).all<RunRow>();
  return results;
}

analytics.get('/benchmarks', (c) =>
  edgeCached(c, 300, async () => {
    const runs = await runsBySuite(c);
    const suites = new Map<string, Map<string, RunRow[]>>();
    for (const r of runs) {
      const s = suites.get(r.suite_id) ?? suites.set(r.suite_id, new Map()).get(r.suite_id)!;
      const k = `${r.language}/${r.runtime}`;
      (s.get(k) ?? s.set(k, []).get(k)!).push(r);
    }
    return {
      totalRuns: runs.length,
      suites: [...suites.entries()].map(([suite, impls]) => ({
        suite,
        implementations: [...impls.entries()].map(([key, rs]) => {
          const best = rs.reduce((a, b) => ((b.moves_per_sec ?? 0) > (a.moves_per_sec ?? 0) ? b : a));
          return {
            key,
            language: best.language,
            runtime: best.runtime,
            runs: rs.length,
            best: { movesPerSec: best.moves_per_sec, gamesPerSec: best.games_per_sec, nodesPerSec: best.nodes_per_sec, avgDecisionUs: best.avg_decision_us, peakMemoryBytes: best.peak_memory, avgScore: best.avg_score },
            efficiency: best.moves_per_sec && best.peak_memory ? best.moves_per_sec / (best.peak_memory / 1048576) : null,
            history: rs.slice(0, 50).reverse().map((r) => ({ at: r.created_at, movesPerSec: r.moves_per_sec })),
          };
        }),
      })),
    };
  }),
);

// ---------------------------------------------------------- leaderboards

analytics.get('/leaderboards', (c) =>
  edgeCached(c, 120, async () => {
    const lim = Math.min(Number(c.req.query('limit') ?? 10) || 10, 50);
    const cols = 'replay_code, score, max_tile, move_count, player_kind, agent_name, finished_at';
    const done = "status IN ('over', 'abandoned')";
    const [scores, tiles, longest] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT ${cols} FROM games WHERE ${done} ORDER BY score DESC LIMIT ?1`).bind(lim),
      c.env.DB.prepare(`SELECT ${cols} FROM games WHERE ${done} ORDER BY max_tile DESC, score DESC LIMIT ?1`).bind(lim),
      c.env.DB.prepare(`SELECT ${cols} FROM games WHERE ${done} ORDER BY move_count DESC LIMIT ?1`).bind(lim),
    ]);
    const game = (r: Record<string, unknown>) => ({ replayCode: r.replay_code, score: r.score, maxTile: r.max_tile, moves: r.move_count, player: r.agent_name ?? r.player_kind, finishedAt: r.finished_at });
    const agents = (await agentList(c, 200)).filter((a) => a.games >= 1);
    const top = <T>(xs: T[], f: (x: T) => number | null, asc = false) =>
      xs.filter((x) => f(x) !== null).sort((a, b) => (asc ? f(a)! - f(b)! : f(b)! - f(a)!)).slice(0, lim);
    const runs = await runsBySuite(c);
    const bestPer = (suite: string, f: (r: RunRow) => number | null) => {
      const m = new Map<string, RunRow>();
      for (const r of runs.filter((r) => r.suite_id === suite && f(r) !== null)) {
        const k = `${r.language}/${r.runtime}`;
        if (!m.has(k) || f(r)! > f(m.get(k)!)!) m.set(k, r);
      }
      return [...m.values()].sort((a, b) => f(b)! - f(a)!).map((r) => ({ language: r.language, runtime: r.runtime, value: f(r), verified: !!r.verified }));
    };
    return {
      scores: {
        highest: (scores.results as Record<string, unknown>[]).map(game),
        highestTiles: (tiles.results as Record<string, unknown>[]).map(game),
        longestRuns: (longest.results as Record<string, unknown>[]).map(game),
      },
      agents: {
        bestAverage: top(agents.filter((a) => a.games >= 3), (a) => a.avgScore),
        bestP99: top(agents.filter((a) => a.games >= 10), (a) => a.p99Score),
        highestTile: top(agents, (a) => a.highestTile),
        fastestDecision: top(agents.filter((a) => a.avgDecisionUs !== null), (a) => a.avgDecisionUs, true),
      },
      runtimes: {
        fastestEngine: bestPer('engine-random-1k', (r) => r.moves_per_sec),
        fastestSearch: bestPer('expectimax-d2-10', (r) => r.moves_per_sec),
        mostEfficient: bestPer('expectimax-d2-10', (r) => (r.moves_per_sec && r.peak_memory ? r.moves_per_sec / (r.peak_memory / 1048576) : null)),
      },
    };
  }),
);

// ------------------------------------------------------------ LLM usage

analytics.get('/llm', (c) =>
  edgeCached(c, 120, async () => {
    const [byModel, recent, daily] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT u.model, u.provider, COUNT(*) AS games, SUM(u.calls) AS calls, SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output,
                SUM(u.cache_read_tokens) AS cache_read, SUM(u.reasoning_tokens) AS reasoning, SUM(u.cost_usd) AS cost,
                SUM(u.cost_usd IS NULL) AS unpriced, SUM(u.cost_estimated) AS estimated,
                AVG(g.score) AS avg_score, MAX(g.score) AS best_score, MAX(g.max_tile) AS best_tile, SUM(g.move_count) AS moves, SUM(g.score) AS points
         FROM llm_usage u LEFT JOIN games g ON g.id = u.game_id GROUP BY u.model, u.provider ORDER BY games DESC LIMIT 50`,
      ),
      c.env.DB.prepare(
        `SELECT u.*, g.replay_code, g.score, g.move_count, g.max_tile, g.status FROM llm_usage u LEFT JOIN games g ON g.id = u.game_id
         ORDER BY u.reported_at DESC LIMIT 20`,
      ),
      c.env.DB.prepare(
        'SELECT day, COUNT(*) AS games, SUM(input_tokens + output_tokens + cache_read_tokens) AS tokens, SUM(cost_usd) AS cost FROM llm_usage WHERE day >= ?1 GROUP BY day ORDER BY day',
      ).bind(daysAgo(29)),
    ]);
    const models = (byModel.results as Record<string, number & string>[]).map((m) => {
      const tokens = (m.input ?? 0) + (m.output ?? 0) + (m.cache_read ?? 0);
      return {
        model: m.model,
        provider: m.provider,
        games: m.games,
        calls: m.calls,
        tokens: { input: m.input, output: m.output, cacheRead: m.cache_read, reasoning: m.reasoning, total: tokens },
        costUsd: m.cost,
        unpricedGames: m.unpriced,
        estimatedGames: m.estimated,
        avgScore: m.avg_score,
        bestScore: m.best_score,
        bestTile: m.best_tile,
        tokensPerMove: m.moves ? tokens / m.moves : null,
        costPerGameUsd: m.cost !== null && m.games ? m.cost / m.games : null,
        pointsPer1kTokens: tokens ? (m.points / tokens) * 1000 : null,
        pointsPerDollar: m.cost ? m.points / m.cost : null,
      };
    });
    const sum = (f: (m: (typeof models)[number]) => number | null) => models.reduce((a, m) => a + (f(m) ?? 0), 0);
    return {
      totals: {
        games: sum((m) => m.games),
        calls: sum((m) => m.calls),
        tokens: sum((m) => m.tokens.total),
        inputTokens: sum((m) => m.tokens.input),
        outputTokens: sum((m) => m.tokens.output),
        costUsd: sum((m) => m.costUsd),
        unpricedGames: sum((m) => m.unpricedGames),
      },
      models,
      recent: (recent.results as Record<string, any>[]).map((r) => ({
        ...usageOut(r as unknown as UsageRow, { score: r.score ?? 0, moveNumber: r.move_count ?? 0, maxTile: r.max_tile ?? 0, status: r.status ?? 'unknown' }),
        replayCode: r.replay_code,
      })),
      daily: daily.results,
      note: 'Token counts are self-reported by LLM agents; costs are client-reported or estimated from list prices (free models = $0).',
    };
  }),
);

// ------------------------------------------------ AI cost & resource impact

/**
 * Estimated cost and environmental footprint of the AI work on the platform.
 * Inputs are recorded quantities (agent decision time, benchmark CPU time, LLM
 * tokens); outputs are estimates using IMPACT_ASSUMPTIONS (returned verbatim).
 */
/** Shared suite for per-language energy efficiency (every port runs it; AI-heavy, so CPU time is meaningful). */
const EFFICIENCY_SUITE = 'expectimax-d2-10';

analytics.get('/impact', (c) =>
  edgeCached(c, 300, async () => {
    const [agentDays, agentsQ, llmByAgent, llmTotals, benchLang, benchAlgo, benchRecent, llmDaily, benchDaily, benchEff] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT day, games, timed_moves, total_time_us, total_moves FROM stats_daily WHERE player_kind = 'agent'"),
      c.env.DB.prepare('SELECT agent_key, name, kind, games, total_moves, timed_moves, total_time_us, total_score FROM agent_stats ORDER BY games DESC LIMIT 200'),
      c.env.DB.prepare('SELECT agent_name, SUM(input_tokens + output_tokens + cache_read_tokens) AS tokens, SUM(cost_usd) AS cost, SUM(calls) AS calls FROM llm_usage GROUP BY agent_name'),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS games, SUM(u.calls) AS calls, SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens) AS tokens, SUM(u.cost_usd) AS cost,
                SUM(g.move_count) AS moves FROM llm_usage u LEFT JOIN games g ON g.id = u.game_id`,
      ),
      c.env.DB.prepare(
        `SELECT language, runtime, COUNT(*) AS runs, SUM(COALESCE(cpu_ms, wall_ms)) AS cpu_ms, SUM(total_moves) AS moves, SUM(games) AS games
         FROM benchmark_runs WHERE status = 'complete' GROUP BY language, runtime`,
      ),
      c.env.DB.prepare(
        `SELECT agent_id, COALESCE(json_extract(agent_config, '$.depth'), 'auto') AS depth, COUNT(*) AS runs,
                SUM(COALESCE(cpu_ms, wall_ms)) AS cpu_ms, SUM(total_moves) AS moves
         FROM benchmark_runs WHERE status = 'complete' GROUP BY agent_id, depth`,
      ),
      c.env.DB.prepare(
        `SELECT id, suite_id, language, runtime, source, COALESCE(cpu_ms, wall_ms) AS cpu_ms, total_moves, games, verified, created_at
         FROM benchmark_runs WHERE status = 'complete' ORDER BY created_at DESC LIMIT 15`,
      ),
      c.env.DB.prepare('SELECT day, SUM(input_tokens + output_tokens + cache_read_tokens) AS tokens, SUM(cost_usd) AS cost FROM llm_usage WHERE day >= ?1 GROUP BY day').bind(daysAgo(29)),
      c.env.DB.prepare("SELECT date(created_at / 1000, 'unixepoch') AS day, SUM(COALESCE(cpu_ms, wall_ms)) AS cpu_ms FROM benchmark_runs WHERE created_at >= ?1 GROUP BY day").bind(Date.parse(daysAgo(29))),
      // Efficiency is compared on ONE shared suite so every language does identical work.
      c.env.DB.prepare(
        `SELECT language, runtime, SUM(COALESCE(cpu_ms, wall_ms)) AS cpu_ms, SUM(total_moves) AS moves
         FROM benchmark_runs WHERE status = 'complete' AND suite_id = ?1 GROUP BY language, runtime`,
      ).bind(EFFICIENCY_SUITE),
    ]);
    type R = Record<string, any>;
    const llmAgents = new Map((llmByAgent.results as R[]).map((r) => [r.agent_name, r]));

    // Per agent: LLM agents are costed by tokens (their decision time is waiting on a
    // remote model, not local CPU); search agents by their measured decision time.
    const perAgent = (agentsQ.results as R[]).map((a) => {
      const llm = llmAgents.get(a.name);
      const seconds = llm ? 0 : (a.total_time_us ?? 0) / 1e6;
      const fp = footprint(seconds, llm?.tokens ?? 0);
      const llmCost = llm?.cost ?? 0;
      return {
        key: a.agent_key,
        name: a.name,
        kind: llm ? 'llm' : a.kind,
        games: a.games,
        moves: a.total_moves,
        inferenceRequests: llm?.calls ?? a.timed_moves ?? 0,
        runtimeSeconds: (a.total_time_us ?? 0) / 1e6,
        ...fp,
        llmCostUsd: llmCost,
        totalCostUsd: fp.computeCostUsd + llmCost,
        costPerGameUsd: a.games ? (fp.computeCostUsd + llmCost) / a.games : null,
        energyPerGameWh: a.games ? (fp.energyKwh * 1000) / a.games : null,
      };
    });

    const eff = new Map((benchEff.results as R[]).map((r) => [`${r.language}/${r.runtime}`, r]));
    const byRuntime = (benchLang.results as R[]).map((r) => {
      const fp = footprint((r.cpu_ms ?? 0) / 1000);
      const e = eff.get(`${r.language}/${r.runtime}`);
      const effKwh = e?.moves ? footprint((e.cpu_ms ?? 0) / 1000).energyKwh : null;
      return { language: r.language, runtime: r.runtime, runs: r.runs, games: r.games, moves: r.moves, ...fp, energyPerMillionMovesWh: effKwh !== null ? (effKwh * 1000 * 1e6) / e!.moves : null };
    });
    const byAlgorithm = (benchAlgo.results as R[]).map((r) => {
      const fp = footprint((r.cpu_ms ?? 0) / 1000);
      const algo = r.agent_id === 'expectimax' ? `expectimax (depth ${r.depth})` : r.agent_id;
      return { algorithm: algo, runs: r.runs, moves: r.moves, ...fp, energyPerMillionMovesWh: r.moves ? (fp.energyKwh * 1000 * 1e6) / r.moves : null };
    });
    const benchRuns = (benchRecent.results as R[]).map((r) => ({
      id: r.id,
      suiteId: r.suite_id,
      language: r.language,
      runtime: r.runtime,
      verified: !!r.verified,
      createdAt: r.created_at,
      ...footprint((r.cpu_ms ?? 0) / 1000),
    }));

    const agentGames = (agentDays.results as R[]).reduce((a, d) => a + d.games, 0);
    const agentRuntimeSeconds = (agentDays.results as R[]).reduce((a, d) => a + (d.total_time_us ?? 0), 0) / 1e6;
    const lt = llmTotals.results[0] as R;
    const agentsFp = sumFootprints(perAgent.map((a) => footprint(a.computeSeconds, a.llmTokens)));
    const benchFp = sumFootprints(byRuntime.map((r) => footprint(r.computeSeconds)));
    const total = sumFootprints([agentsFp, benchFp]);
    const llmCost = lt?.cost ?? 0;
    const totalCost = total.computeCostUsd + llmCost;

    // 30-day trend of estimated energy (Wh): agent decisions + LLM tokens + benchmarks.
    const trend = Array.from({ length: 30 }, (_, i) => {
      const day = daysAgo(29 - i);
      const ag = (agentDays.results as R[]).find((d) => d.day === day);
      const ll = (llmDaily.results as R[]).find((d) => d.day === day);
      const bd = (benchDaily.results as R[]).find((d) => d.day === day);
      const fp = footprint((ag?.total_time_us ?? 0) / 1e6 + (bd?.cpu_ms ?? 0) / 1000, ll?.tokens ?? 0);
      return { day, energyWh: fp.energyKwh * 1000, costUsd: fp.computeCostUsd + (ll?.cost ?? 0) };
    });

    return {
      totals: {
        estimatedCostUsd: totalCost,
        computeCostUsd: total.computeCostUsd,
        llmCostUsd: llmCost,
        benchmarkComputeCostUsd: benchFp.computeCostUsd,
        agentGames,
        costPerAgentGameUsd: agentGames ? (agentsFp.computeCostUsd + llmCost) / agentGames : null,
        costPerAgentUsd: perAgent.length ? (agentsFp.computeCostUsd + llmCost) / perAgent.length : null,
        inferenceRequests: perAgent.reduce((a, x) => a + x.inferenceRequests, 0),
        llmTokens: lt?.tokens ?? 0,
        avgTokensPerLlmGame: lt?.games ? (lt.tokens ?? 0) / lt.games : null,
        avgTokensPerLlmMove: lt?.moves ? (lt.tokens ?? 0) / lt.moves : null,
        agentRuntimeSeconds,
        benchmarkComputeSeconds: benchFp.computeSeconds,
      },
      footprint: { ...total, ...equivalents(total.energyKwh) },
      byAgent: perAgent.sort((a, b) => b.totalCostUsd - a.totalCostUsd),
      efficiencySuite: EFFICIENCY_SUITE,
      byRuntime: byRuntime.sort((a, b) => (a.energyPerMillionMovesWh ?? Infinity) - (b.energyPerMillionMovesWh ?? Infinity)),
      byAlgorithm,
      benchmarkRuns: benchRuns,
      trend,
      assumptions: IMPACT_ASSUMPTIONS,
      disclaimer:
        'Estimates for education, not measurements: recorded compute time and tokens × the stated assumptions. Real values vary with hardware, region, model and data centre.',
    };
  }),
);

// --------------------------------------------------------------- devices

analytics.get('/devices', (c) =>
  edgeCached(c, 600, async () => {
    const days = clampDays(c, 30);
    const { results } = await c.env.DB.prepare('SELECT dim, value, SUM(n) AS n FROM dims_daily WHERE day >= ?1 GROUP BY dim, value ORDER BY n DESC')
      .bind(daysAgo(days - 1))
      .all<{ dim: string; value: string; n: number }>();
    const out: Record<string, { value: string; n: number; share: number }[]> = {};
    for (const dim of ['country', 'device', 'browser', 'os']) {
      const rs = results.filter((r) => r.dim === dim);
      const total = rs.reduce((a, r) => a + r.n, 0);
      out[dim] = rs.slice(0, 25).map((r) => ({ value: r.value, n: r.n, share: total ? r.n / total : 0 }));
    }
    return { days, sessions: out.device.reduce((a, r) => a + r.n, 0), ...out, note: 'Aggregated per day from one beacon per browser session; no IPs or identifiers are stored.' };
  }),
);

// ------------------------------------------------------ client beacon

function classifyUA(ua: string) {
  const device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : /bot|crawl|spider|headless/i.test(ua) ? 'bot' : 'desktop';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return { device, browser, os };
}

const COUNTERS = new Set(['replay_views', 'games_started', 'page_views', 'ai_games_started', 'benchmarks_run_browser']);

/**
 * One beacon per browser session (sent on page hide): session-level counters
 * and, on the session's first beacon, aggregated device/browser/os/country.
 */
analytics.post('/events', async (c) => {
  await rateLimit(c, 'WRITE_LIMITER');
  const b = await body<{ sessionId?: string; first?: boolean; counters?: Record<string, number> }>(c);
  if (!isClientId(b.sessionId)) throw new ApiError('BAD_REQUEST', 'sessionId required');
  const day = today();
  const stmts: D1PreparedStatement[] = [];
  for (const [name, raw] of Object.entries(b.counters ?? {})) {
    const v = Math.floor(Number(raw));
    if (!COUNTERS.has(name) || !(v > 0) || v > 10_000) continue;
    stmts.push(
      c.env.DB.prepare('INSERT INTO counters_daily (day, name, value) VALUES (?1, ?2, ?3) ON CONFLICT(day, name) DO UPDATE SET value = value + excluded.value').bind(day, name, v),
    );
  }
  if (b.first) {
    const ua = classifyUA(c.req.header('user-agent') ?? '');
    const country = (c.req.raw as unknown as { cf?: { country?: string } }).cf?.country ?? 'unknown';
    for (const [dim, value] of [['country', country], ['device', ua.device], ['browser', ua.browser], ['os', ua.os]] as const) {
      stmts.push(c.env.DB.prepare('INSERT INTO dims_daily (day, dim, value, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(day, dim, value) DO UPDATE SET n = n + 1').bind(day, dim, value));
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  log('debug', 'analytics.beacon', { statements: stmts.length });
  return c.body(null, 204);
});
