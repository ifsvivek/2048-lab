/**
 * /v1/benchmarks — shared suites, submitted cross-language results, language
 * comparisons, and server-run benchmark sessions.
 */
import { Hono } from 'hono';
import { ulid, SPEC_VERSION } from '@g2048/engine';
import type { BenchmarkResult, BenchmarkSuite } from '@g2048/engine/sim';
import expectedFixture from '../../../../spec/fixtures/benchmarks.json';
import expectedHeavy from '../../../../spec/fixtures/benchmarks-heavy.json';
import suiteRandom1k from '../../../../spec/benchmarks/engine-random-1k.json';
import suiteRandom10k from '../../../../spec/benchmarks/engine-random-10k.json';
import suiteD2 from '../../../../spec/benchmarks/expectimax-d2-10.json';
import suiteD3 from '../../../../spec/benchmarks/expectimax-d3-opening.json';
import suiteCanonical from '../../../../spec/benchmarks/expectimax-canonical-3.json';
import type { BenchConfig } from '../do/benchmark-session.ts';
import { agentByKey } from '../lib/db.ts';
import { type DriverSpec, sanitizeBuiltinConfig } from '../lib/driver.ts';
import { ApiError } from '../lib/errors.ts';
import { type AppEnv, type Ctx, bearer, body, edgeCached, optInt, optObj, optStr, rateLimit, rpc } from '../lib/http.ts';

export const benchmarks = new Hono<AppEnv>();

export const SUITES = [suiteRandom1k, suiteRandom10k, suiteD2, suiteD3, suiteCanonical] as unknown as BenchmarkSuite[];
type Expected = Record<string, { checksum: string; totalMoves: number; totalScore: number }>;
const EXPECTED: Expected = { ...(expectedFixture as { suites: Expected }).suites, ...(expectedHeavy as { suites: Expected }).suites };
const LANGUAGES = new Set(['typescript', 'rust', 'go', 'python', 'c', 'cpp', 'java', 'csharp', 'lua']);

benchmarks.get('/suites', (c) => c.json({ suites: SUITES.map((s) => ({ ...s, expected: EXPECTED[s.id] ?? null })) }));

/** Submit a BenchmarkResult (spec/schemas/benchmark-result.schema.json) produced by any runtime. */
benchmarks.post('/runs', async (c) => {
  await rateLimit(c, 'WRITE_LIMITER');
  const r = await body<BenchmarkResult>(c);
  const impl = r.implementation;
  const s = r.summary;
  if (r.schemaVersion !== 1 || !impl || !s || !Array.isArray(r.games) || typeof r.suiteId !== 'string') {
    throw new ApiError('BAD_REQUEST', 'body must be a BenchmarkResult (schemaVersion 1)');
  }
  const language = String(impl.language).toLowerCase();
  if (!LANGUAGES.has(language)) throw new ApiError('BAD_REQUEST', `implementation.language must be one of ${[...LANGUAGES].join(', ')}`);
  // Runners may truncate `games` (only 1,000 compact rows are stored); summary and checksum cover all games.
  if (r.games.length === 0 || r.games.length > 20000) throw new ApiError('BAD_REQUEST', 'games must have 1..20000 entries');
  const suite = SUITES.find((x) => x.id === r.suiteId);
  const expected = EXPECTED[r.suiteId];
  // "verified" = this run reproduced the reference outcome bit-for-bit.
  const verified = !!expected && r.checksum === expected.checksum && s.totalMoves === expected.totalMoves;
  const id = ulid();
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  await c.env.DB.prepare(
    `INSERT INTO benchmark_runs (id, source, status, suite_id, spec_version, language, runtime, runtime_version, platform, agent_id,
       agent_config, environment, deterministic, verified, checksum, games, avg_score, max_score, max_tile, total_moves, wall_ms, cpu_ms,
       games_per_sec, moves_per_sec, nodes_per_sec, avg_decision_us, p99_decision_us, peak_memory, summary, results, created_at)
     VALUES (?1, ?2, 'complete', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)`,
  )
    .bind(
      id,
      impl.runtime === 'browser' ? 'browser' : 'runner',
      r.suiteId,
      r.specVersion ?? SPEC_VERSION,
      language,
      String(impl.runtime ?? 'unknown').slice(0, 32),
      String(impl.runtimeVersion ?? '').slice(0, 64),
      String(impl.platform ?? '').slice(0, 32),
      String(r.agent?.id ?? suite?.agent.id ?? 'unknown').slice(0, 64),
      JSON.stringify(r.agent?.config ?? {}),
      JSON.stringify(r.environment ?? {}).slice(0, 2000),
      r.deterministic ? 1 : 0,
      verified ? 1 : 0,
      String(r.checksum ?? '').slice(0, 8),
      typeof s.games === 'number' ? s.games : r.games.length,
      num(s.avgScore),
      num(s.maxScore),
      num(s.maxTile),
      num(s.totalMoves),
      num(s.wallMs),
      num(s.cpuMs),
      num(s.gamesPerSec),
      num(s.movesPerSec),
      num(s.nodesPerSec),
      num(s.avgDecisionUs),
      num(s.p99DecisionUs),
      num(s.peakMemoryBytes),
      JSON.stringify(s),
      // Compact per-game rows; full game records stay with the runner.
      JSON.stringify(r.games.slice(0, 1000).map((g) => [g.seed, g.score, g.maxTile, g.moveCount, g.historyHash])),
      Date.now(),
    )
    .run();
  return c.json({ id, verified, expectedChecksum: expected?.checksum ?? null }, 201);
});

const RUN_COLUMNS = `id, source, status, suite_id, language, runtime, runtime_version, platform, agent_id, deterministic, verified, checksum,
  games, avg_score, max_score, max_tile, total_moves, wall_ms, cpu_ms, games_per_sec, moves_per_sec, nodes_per_sec,
  avg_decision_us, p99_decision_us, peak_memory, created_at`;

function runOut(r: Record<string, unknown>) {
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    suiteId: r.suite_id,
    language: r.language,
    runtime: r.runtime,
    runtimeVersion: r.runtime_version,
    platform: r.platform,
    agentId: r.agent_id,
    deterministic: !!r.deterministic,
    verified: !!r.verified,
    checksum: r.checksum,
    games: r.games,
    avgScore: r.avg_score,
    maxScore: r.max_score,
    maxTile: r.max_tile,
    totalMoves: r.total_moves,
    wallMs: r.wall_ms,
    cpuMs: r.cpu_ms,
    gamesPerSec: r.games_per_sec,
    movesPerSec: r.moves_per_sec,
    nodesPerSec: r.nodes_per_sec,
    avgDecisionUs: r.avg_decision_us,
    p99DecisionUs: r.p99_decision_us,
    peakMemoryBytes: r.peak_memory,
    createdAt: r.created_at,
  };
}

benchmarks.get('/runs', (c) =>
  edgeCached(c, 30, async () => {
    const suite = c.req.query('suite');
    const language = c.req.query('language');
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const where: string[] = ["status = 'complete'"];
    const args: unknown[] = [];
    if (suite) {
      args.push(suite);
      where.push(`suite_id = ?${args.length}`);
    }
    if (language) {
      args.push(language);
      where.push(`language = ?${args.length}`);
    }
    args.push(limit);
    const { results } = await c.env.DB.prepare(`SELECT ${RUN_COLUMNS} FROM benchmark_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?${args.length}`)
      .bind(...args)
      .all();
    return { runs: results.map(runOut) };
  }),
);

benchmarks.get('/runs/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM benchmark_runs WHERE id = ?1').bind(c.req.param('id').toUpperCase()).first<Record<string, unknown>>();
  if (!r) throw new ApiError('BENCHMARK_NOT_FOUND', 'benchmark run not found');
  return c.json({ ...runOut(r), summary: JSON.parse(String(r.summary)), results: r.results ? JSON.parse(String(r.results)) : [], environment: JSON.parse(String(r.environment ?? '{}')), agentConfig: JSON.parse(String(r.agent_config ?? '{}')) });
});

/**
 * Per-language comparison for one suite: best and latest run per language
 * and runtime, plus a short history for trend lines.
 */
benchmarks.get('/compare', (c) =>
  edgeCached(c, 60, async () => {
    const suite = c.req.query('suite') ?? 'engine-random-1k';
    const { results } = await c.env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM benchmark_runs WHERE suite_id = ?1 AND status = 'complete' ORDER BY created_at DESC LIMIT 400`,
    )
      .bind(suite)
      .all();
    const byImpl = new Map<string, ReturnType<typeof runOut>[]>();
    for (const row of results.map(runOut)) {
      const k = `${row.language}/${row.runtime}`;
      if (!byImpl.has(k)) byImpl.set(k, []);
      byImpl.get(k)!.push(row);
    }
    const implementations = [...byImpl.entries()].map(([key, runs]) => {
      const best = runs.reduce((a, b) => ((Number(b.movesPerSec) || 0) > (Number(a.movesPerSec) || 0) ? b : a));
      return { key, language: runs[0].language, runtime: runs[0].runtime, runs: runs.length, latest: runs[0], best, history: runs.slice(0, 30).reverse() };
    });
    return { suite, expected: EXPECTED[suite] ?? null, implementations };
  }),
);

// ------------------------------------------------------ server-run sessions

function benchStub(c: Ctx, id: string) {
  return c.env.BENCH.getByName(id);
}

benchmarks.post('/sessions', async (c) => {
  await rateLimit(c, 'CREATE_LIMITER');
  const b = await body(c);
  const agentRef = optStr(b.agent, 'agent', 64) ?? 'builtin/greedy';
  const maxGames = Number(c.env.MAX_SERVER_BENCH_GAMES) || 20;
  const games = optInt(b.games, 'games', 1, maxGames) ?? 5;
  const seedStart = optInt(b.seedStart, 'seedStart', 0, 0xffffffff) ?? 1;
  const maxMoves = optInt(b.maxMoves, 'maxMoves', 1, 20000) ?? 5000;
  let driver: DriverSpec;
  let agentId: string;
  let agentName: string;
  if (agentRef === 'builtin/greedy' || agentRef === 'builtin/expectimax') {
    const name = agentRef.slice(8) as 'greedy' | 'expectimax';
    driver = { type: 'builtin', agent: name, config: sanitizeBuiltinConfig(name, optObj(b.config, 'config')) };
    agentId = agentRef;
    agentName = name;
  } else {
    const key = bearer(c);
    const agent = key ? await agentByKey(c.env.DB, key) : null;
    if (!agent || (agent.id !== agentRef.toUpperCase() && agent.name !== agentRef)) {
      throw new ApiError('UNAUTHORIZED', 'benchmarking a registered agent requires its API key (Authorization: Bearer <apiKey>); built-ins: builtin/greedy, builtin/expectimax');
    }
    if (!agent.endpoint) throw new ApiError('BAD_REQUEST', 'agent has no push endpoint registered');
    driver = { type: 'remote', endpoint: agent.endpoint, timeoutMs: 5000 };
    agentId = agent.id;
    agentName = agent.name;
  }
  const benchmarkId = ulid();
  const config: BenchConfig = { benchmarkId, agentId, agentName, driver, games, seedStart, maxMoves, createdAt: Date.now() };
  const status = await rpc(benchStub(c, benchmarkId).start(config));
  return c.json({ ...status, links: { self: `/v1/benchmarks/sessions/${benchmarkId}`, live: `/v1/benchmarks/sessions/${benchmarkId}/live` } }, 201);
});

benchmarks.get('/sessions/:id', async (c) => {
  const id = c.req.param('id').toUpperCase();
  const row = await c.env.DB.prepare("SELECT id FROM benchmark_runs WHERE id = ?1 AND source = 'server'").bind(id).first();
  if (!row) throw new ApiError('BENCHMARK_NOT_FOUND', 'benchmark session not found');
  return c.json(await rpc(benchStub(c, id).status()));
});

benchmarks.get('/sessions/:id/live', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new ApiError('BAD_REQUEST', 'expected a WebSocket upgrade');
  return benchStub(c, c.req.param('id').toUpperCase()).fetch(c.req.raw);
});
