/**
 * 2048 Platform public API — a Hono app on Cloudflare Workers.
 *
 *   /v1/games        live server-side games (API / MCP / platform-driven agents)
 *   /v1/replays      verified replay upload, replay fetch, live spectating
 *   /v1/agents       agent registration, stats, push-agent runs
 *   /v1/benchmarks   suites, cross-language results, comparisons, server sessions
 *   /v1/leaderboard  top games and agents
 *   /v1/stats        aggregate platform statistics
 *   /v1/analytics    analytics & insights (aggregate tables only; see migrations/0002)
 *
 * Contract: spec/openapi.yaml. Errors: { error: true, code, message, details? }.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { SPEC_VERSION } from '@g2048/engine';
import { ApiError, decodeRpcError } from './lib/errors.ts';
import type { AppEnv } from './lib/http.ts';
import { log } from './lib/log.ts';
import { runRollup } from './lib/rollup.ts';
import { agents } from './routes/agents.ts';
import { analytics } from './routes/analytics.ts';
import { benchmarks } from './routes/benchmarks.ts';
import { games } from './routes/games.ts';
import { replays } from './routes/replays.ts';
import { stats } from './routes/stats.ts';

export { GameSession } from './do/game-session.ts';
export { BenchmarkSession } from './do/benchmark-session.ts';

const API_VERSION = '1.0.0';

const app = new Hono<AppEnv>();

app.use('*', cors({ origin: '*', allowHeaders: ['content-type', 'authorization'], allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 86400 }));
app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));

// Structured request log + API metrics (one line per request).
app.use('*', async (c, next) => {
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  const t0 = Date.now();
  await next();
  if (c.req.method === 'OPTIONS') return;
  c.header('x-request-id', requestId);
  log(c.res.status >= 500 ? 'error' : 'info', 'http.request', {
    requestId,
    method: c.req.method,
    route: c.req.routePath,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - t0,
    cache: c.res.headers.get('x-cache'),
    colo: (c.req.raw as unknown as { cf?: { colo?: string } }).cf?.colo,
  });
});

app.get('/', (c) =>
  c.json({
    name: '2048 Platform API',
    version: API_VERSION,
    specVersion: SPEC_VERSION,
    docs: 'https://github.com/ (see spec/openapi.yaml and spec/AGENT_PROTOCOL.md)',
    endpoints: ['/v1/games', '/v1/replays', '/v1/agents', '/v1/benchmarks', '/v1/leaderboard', '/v1/stats', '/v1/analytics/overview', '/v1/health'],
  }),
);

app.get('/v1/health', (c) => c.json({ ok: true, version: API_VERSION, specVersion: SPEC_VERSION, time: Date.now() }));

app.route('/v1/games', games);
app.route('/v1/replays', replays);
app.route('/v1/agents', agents);
app.route('/v1/benchmarks', benchmarks);
app.route('/v1/analytics', analytics);
app.route('/v1', stats);

app.notFound((c) => c.json(new ApiError('NOT_FOUND', `no route for ${c.req.method} ${c.req.path}`).toJSON(), 404));

app.onError((err, c) => {
  const e = err instanceof ApiError ? err : decodeRpcError(err);
  if (e) return c.json(e.toJSON(), e.status as 400);
  log('error', 'http.unhandled', { requestId: c.get('requestId'), path: c.req.path, message: err.message, stack: err.stack });
  return c.json(new ApiError('INTERNAL', 'internal error').toJSON(), 500);
});

export default {
  fetch: app.fetch,
  /** Daily analytics rollup (wrangler.jsonc triggers.crons). */
  async scheduled(_event: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    ctx.waitUntil(runRollup(env.DB));
  },
} satisfies ExportedHandler<AppEnv['Bindings']>;
