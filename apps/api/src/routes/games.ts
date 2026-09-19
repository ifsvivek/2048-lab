/** /v1/games — live server-side games (API, MCP and platform-driven agents). */
import { Hono } from 'hono';
import { generateReplayCode, isUlid, randomSeed, ulid } from '@g2048/engine';
import type { SessionMeta } from '../do/game-session.ts';
import { agentByKey, getGameRow } from '../lib/db.ts';
import { type DriverSpec, sanitizeBuiltinConfig } from '../lib/driver.ts';
import { ApiError } from '../lib/errors.ts';
import { type AppEnv, type Ctx, bearer, body, edgeCached, optInt, optObj, optStr, rateLimit, rpc } from '../lib/http.ts';
import { estimateCostUsd, normalizeModel } from '../lib/pricing.ts';
import { type PlayerInfo, stateFromRow } from '../lib/state.ts';
import { type UsageRow, usageOut } from '../lib/usage.ts';

export const games = new Hono<AppEnv>();

const SOURCES = new Set(['api', 'mcp', 'web', 'runner']);
const BUILTINS = new Set(['random', 'greedy', 'expectimax']);

export function gameStub(c: Ctx, gameId: string) {
  return c.env.GAME.getByName(gameId);
}

interface CreateOptions {
  seed?: number;
  source: string;
  player: PlayerInfo;
  agentConfig?: Record<string, unknown> | null;
  runtime?: Record<string, unknown> | null;
  driver?: SessionMeta['driver'];
}

/** Create a live game backed by a GameSession Durable Object. */
export async function createLiveGame(c: Ctx, o: CreateOptions) {
  const gameId = ulid();
  const meta: SessionMeta = {
    gameId,
    replayCode: generateReplayCode(),
    seed: o.seed ?? randomSeed(),
    source: o.source,
    player: o.player,
    agentConfig: o.agentConfig ?? null,
    runtime: o.runtime ?? null,
    startedAt: Date.now(),
    driver: o.driver ?? null,
  };
  return rpc(gameStub(c, gameId).create(meta));
}

games.post('/', async (c) => {
  await rateLimit(c, 'CREATE_LIMITER');
  const b = await body(c);
  const seed = optInt(b.seed, 'seed', 0, 0xffffffff);
  const source = optStr(b.source, 'source', 20) ?? 'api';
  if (!SOURCES.has(source)) throw new ApiError('BAD_REQUEST', `source must be one of ${[...SOURCES].join(', ')}`);
  const runtime = optObj(b.runtime, 'runtime') ?? null;
  const agentInfo = optObj(b.agent, 'agent');
  const builtin = optStr(b.builtin, 'builtin', 20);

  let player: PlayerInfo = { kind: 'human' };
  let driver: SessionMeta['driver'] = null;
  let agentConfig: Record<string, unknown> | null = null;

  const key = bearer(c);
  if (key) {
    const agent = await agentByKey(c.env.DB, key);
    if (!agent) throw new ApiError('UNAUTHORIZED', 'unknown agent API key');
    player = { kind: 'agent', agentId: agent.id, name: agent.name, version: agent.version };
    agentConfig = optObj(agentInfo?.config, 'agent.config') ?? null;
  } else if (builtin) {
    // Platform-driven built-in agent (spectator demo / smoke test).
    if (!BUILTINS.has(builtin)) throw new ApiError('BAD_REQUEST', `builtin must be one of ${[...BUILTINS].join(', ')}`);
    const config = sanitizeBuiltinConfig(builtin, optObj(b.config, 'config'));
    const spec: DriverSpec = { type: 'builtin', agent: builtin as 'random' | 'greedy' | 'expectimax', config };
    driver = { ...spec, maxMoves: optInt(b.maxMoves, 'maxMoves', 1, 100000) ?? 100000, delayMs: optInt(b.delayMs, 'delayMs', 0, 5000) ?? 150 };
    player = { kind: 'agent', agentId: `builtin/${builtin}`, name: builtin, version: '1.0.0' };
    agentConfig = config;
  } else if (agentInfo) {
    // Unregistered agent: attributed by name only (not eligible for agent stats).
    const name = optStr(agentInfo.name, 'agent.name', 64);
    if (name) player = { kind: 'agent', agentId: null, name, version: optStr(agentInfo.version, 'agent.version', 32) ?? null };
    agentConfig = optObj(agentInfo.config, 'agent.config') ?? null;
  }

  const state = await createLiveGame(c, { seed, source, player, agentConfig, runtime, driver });
  return c.json(state, 201);
});

/** Live games for spectating. Only public handles (replay codes) are listed — never game IDs. */
games.get('/', (c) =>
  edgeCached(c, 10, async () => {
    const limit = Math.min(Number(c.req.query('limit') ?? 30) || 30, 100);
    const { results } = await c.env.DB.prepare(
      `SELECT replay_code, seed, source, player_kind, agent_id, agent_name, started_at FROM games
       WHERE status = 'live' ORDER BY started_at DESC LIMIT ?1`,
    )
      .bind(limit)
      .all();
    return {
      live: results.map((r) => ({
        replayCode: r.replay_code,
        seed: r.seed,
        source: r.source,
        player: { kind: r.player_kind, agentId: r.agent_id, name: r.agent_name },
        startedAt: r.started_at,
        spectate: `/v1/replays/${r.replay_code}/live`,
      })),
    };
  }),
);

games.get('/:id', async (c) => {
  const id = c.req.param('id').toUpperCase();
  if (!isUlid(id)) throw new ApiError('GAME_NOT_FOUND', 'The supplied gameId does not exist.');
  const live = await rpc(gameStub(c, id).getState());
  if (live) return c.json(live);
  const row = await getGameRow(c.env.DB, id);
  if (!row) throw new ApiError('GAME_NOT_FOUND', 'The supplied gameId does not exist.');
  return c.json(stateFromRow(row));
});

games.post('/:id/moves', async (c) => {
  await rateLimit(c, 'WRITE_LIMITER');
  const id = c.req.param('id').toUpperCase();
  if (!isUlid(id)) throw new ApiError('GAME_NOT_FOUND', 'The supplied gameId does not exist.');
  const b = await body(c);
  let moves: (string | number)[];
  if (typeof b.move === 'string' || typeof b.move === 'number') moves = [b.move];
  else if (Array.isArray(b.moves)) moves = b.moves as (string | number)[];
  else if (typeof b.moves === 'string') moves = [...b.moves];
  else throw new ApiError('BAD_REQUEST', "provide 'move' (\"up\"|\"down\"|\"left\"|\"right\") or 'moves' (array, or a string like \"ULDR\")");
  if (moves.length === 0 || moves.length > 1000) throw new ApiError('BAD_REQUEST', 'between 1 and 1000 moves per request');
  const timing = Array.isArray(b.timing) ? (b.timing as number[]).slice(0, moves.length) : undefined;
  const metrics = optObj(b.metrics, 'metrics');
  let out;
  try {
    out = await rpc(gameStub(c, id).submitMoves(moves, timing, metrics));
  } catch (e) {
    // Finished games live only in D1; distinguish "over" from "never existed".
    if (e instanceof ApiError && e.code === 'GAME_NOT_FOUND') {
      const row = await getGameRow(c.env.DB, id);
      if (row) throw new ApiError('GAME_OVER', 'The game is over; no further moves are accepted.', { state: stateFromRow(row) });
    }
    throw e;
  }
  // The full state is top-level so the response alone suffices for the next decision.
  return c.json({ ...out.state, applied: out.applied, rejected: out.rejected });
});

games.post('/:id/resign', async (c) => {
  const id = c.req.param('id').toUpperCase();
  if (!isUlid(id)) throw new ApiError('GAME_NOT_FOUND', 'The supplied gameId does not exist.');
  const stub = gameStub(c, id);
  if (!(await rpc(stub.getState()))) throw new ApiError('GAME_NOT_FOUND', 'The supplied gameId does not exist or is already finished.');
  return c.json(await rpc(stub.resign()));
});

const PROVIDERS = new Set(['anthropic', 'openrouter', 'openai', 'google', 'other']);
const nonNeg = (v: unknown, name: string) => optInt(v, name, 0, 1e12) ?? 0;

/**
 * Record an LLM's token / cost burn for a game (cumulative totals; re-reporting
 * replaces). Self-reported by the client — the platform cannot observe tokens.
 * If `costUsd` is omitted it is estimated from the model's price table.
 */
games.post('/:id/usage', async (c) => {
  await rateLimit(c, 'WRITE_LIMITER');
  const id = c.req.param('id').toUpperCase();
  if (!isUlid(id)) throw new ApiError('GAME_NOT_FOUND', 'The supplied gameId does not exist.');
  const b = await body(c);
  const model = optStr(b.model, 'model', 100);
  if (!model) throw new ApiError('BAD_REQUEST', 'model is required (e.g. "claude-opus-5" or "deepseek/deepseek-v4-flash-0731:free")');
  const provider = (optStr(b.provider, 'provider', 20) ?? 'other').toLowerCase();
  if (!PROVIDERS.has(provider)) throw new ApiError('BAD_REQUEST', `provider must be one of ${[...PROVIDERS].join(', ')}`);
  const t = { input: nonNeg(b.inputTokens, 'inputTokens'), output: nonNeg(b.outputTokens, 'outputTokens'), cacheRead: nonNeg(b.cacheReadTokens, 'cacheReadTokens') };
  const reasoning = nonNeg(b.reasoningTokens, 'reasoningTokens');
  const calls = nonNeg(b.calls, 'calls');
  let cost: number | null = null;
  let estimated = false;
  if (b.costUsd !== undefined && b.costUsd !== null) {
    if (typeof b.costUsd !== 'number' || !Number.isFinite(b.costUsd) || b.costUsd < 0 || b.costUsd > 100_000) throw new ApiError('BAD_REQUEST', 'costUsd must be a non-negative number');
    cost = b.costUsd;
  } else {
    cost = estimateCostUsd(model, t);
    estimated = cost !== null;
  }

  // The game must exist; live games answer from their Durable Object, finished ones from D1.
  const live = await rpc(gameStub(c, id).getState());
  const row = live ? null : await getGameRow(c.env.DB, id);
  if (!live && !row) throw new ApiError('GAME_NOT_FOUND', 'The supplied gameId does not exist.');
  const st = live ?? stateFromRow(row!);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO llm_usage (game_id, day, provider, model, agent_name, source, calls, input_tokens, output_tokens, cache_read_tokens,
       reasoning_tokens, cost_usd, cost_estimated, reported_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(game_id) DO UPDATE SET day = excluded.day, provider = excluded.provider, model = excluded.model,
       agent_name = excluded.agent_name, source = excluded.source, calls = excluded.calls, input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens, reasoning_tokens = excluded.reasoning_tokens,
       cost_usd = excluded.cost_usd, cost_estimated = excluded.cost_estimated, reported_at = excluded.reported_at`,
  )
    .bind(id, new Date(now).toISOString().slice(0, 10), provider, normalizeModel(model), st.player.name ?? null, optStr(b.source, 'source', 10) === 'mcp' ? 'mcp' : 'api', calls, t.input, t.output, t.cacheRead, reasoning, cost, estimated ? 1 : 0, now)
    .run();
  const saved = await c.env.DB.prepare('SELECT * FROM llm_usage WHERE game_id = ?1').bind(id).first<UsageRow>();
  return c.json(usageOut(saved!, { score: st.score, moveNumber: st.moveNumber, maxTile: st.maxTile, status: st.status }));
});
