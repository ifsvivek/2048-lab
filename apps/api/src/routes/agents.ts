/** /v1/agents — registration, stats, and platform-driven runs of push agents. */
import { Hono } from 'hono';
import { isUlid, ulid } from '@g2048/engine';
import { type AgentRow, agentByKey, publicAgent, sha256Hex } from '../lib/db.ts';
import { validateEndpoint } from '../lib/driver.ts';
import { ApiError } from '../lib/errors.ts';
import { type AppEnv, type Ctx, bearer, body, edgeCached, optInt, optStr, rateLimit } from '../lib/http.ts';
import { createLiveGame } from './games.ts';

export const agents = new Hono<AppEnv>();

const KINDS = new Set(['remote', 'worker', 'llm', 'search', 'rl', 'mcp', 'other']);

export const BUILTIN_AGENTS = [
  { id: 'builtin/expectimax', name: 'expectimax', kind: 'search', language: 'typescript', version: '1.0.0', description: 'Canonical expectimax (spec/AI.md). Server-driven runs are capped at depth 2.' },
  { id: 'builtin/greedy', name: 'greedy', kind: 'search', language: 'typescript', version: '1.0.0', description: 'One-ply: maximise empty cells.' },
  { id: 'builtin/random', name: 'random', kind: 'other', language: 'typescript', version: '1.0.0', description: 'SPEC §10 reference random agent.' },
];

function newApiKey(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return 'g2048_' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

agents.post('/', async (c) => {
  await rateLimit(c, 'CREATE_LIMITER');
  const b = await body(c);
  const name = optStr(b.name, 'name', 64);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,63}$/.test(name)) {
    throw new ApiError('BAD_REQUEST', 'name is required: 2–64 chars of letters, digits, space, dot, underscore or dash');
  }
  const kind = optStr(b.kind, 'kind', 16) ?? 'remote';
  if (!KINDS.has(kind)) throw new ApiError('BAD_REQUEST', `kind must be one of ${[...KINDS].join(', ')}`);
  const endpoint = optStr(b.endpoint, 'endpoint', 500);
  if (endpoint) validateEndpoint(endpoint);
  const apiKey = newApiKey();
  const id = ulid();
  try {
    await c.env.DB.prepare(
      `INSERT INTO agents (id, name, kind, language, runtime, version, description, endpoint, key_hash, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        id,
        name,
        kind,
        optStr(b.language, 'language', 32) ?? null,
        optStr(b.runtime, 'runtime', 32) ?? null,
        optStr(b.version, 'version', 32) ?? '1.0.0',
        optStr(b.description, 'description', 500) ?? null,
        endpoint ?? null,
        await sha256Hex(apiKey),
        Date.now(),
      )
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new ApiError('CONFLICT', `an agent named '${name}' already exists`);
    throw e;
  }
  const row = await c.env.DB.prepare('SELECT * FROM agents WHERE id = ?1').bind(id).first<AgentRow>();
  return c.json({ agent: publicAgent(row!), apiKey, note: 'Store the apiKey now; it is shown only once. Send it as `Authorization: Bearer <apiKey>` when creating games.' }, 201);
});

agents.get('/', (c) =>
  edgeCached(c, 60, async () => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const { results } = await c.env.DB.prepare('SELECT * FROM agents ORDER BY best_score DESC, created_at ASC LIMIT ?1').bind(limit).all<AgentRow>();
    return { builtin: BUILTIN_AGENTS, agents: results.map(publicAgent) };
  }),
);

async function findAgent(c: Ctx, ref: string): Promise<AgentRow | null> {
  if (isUlid(ref.toUpperCase())) return c.env.DB.prepare('SELECT * FROM agents WHERE id = ?1').bind(ref.toUpperCase()).first<AgentRow>();
  return c.env.DB.prepare('SELECT * FROM agents WHERE name = ?1').bind(ref).first<AgentRow>();
}

/** Aggregate stats for an agent by ID or name; built-ins are computed from their games. */
agents.get('/:ref{.+}', async (c) => {
  const ref = decodeURIComponent(c.req.param('ref'));
  const builtin = BUILTIN_AGENTS.find((a) => a.id === ref || a.name === ref);
  if (builtin) {
    return edgeCached(c, 60, async () => {
      // Aggregates come from agent_stats (maintained incrementally), never a scan of games.
      const s = await c.env.DB.prepare('SELECT * FROM agent_stats WHERE agent_key = ?1').bind(builtin.id).first<Record<string, number>>();
      const games = s?.games ?? 0;
      return {
        ...builtin,
        stats: {
          gamesPlayed: games,
          totalMoves: s?.total_moves ?? 0,
          avgScore: games ? Math.round(s!.total_score / games) : 0,
          bestScore: s?.best_score ?? 0,
          bestTile: s?.best_tile ?? 0,
          reachRates: Object.fromEntries([2048, 4096, 8192, 16384, 32768, 65536].map((t) => [t, games ? (s?.[`r${t}`] ?? 0) / games : 0])),
        },
        topGames: await topGames(c, builtin.id),
      };
    });
  }
  const agent = await findAgent(c, ref);
  if (!agent) throw new ApiError('AGENT_NOT_FOUND', `no agent '${ref}'`);
  return c.json({ ...publicAgent(agent), topGames: await topGames(c, agent.id) });
});

async function topGames(c: Ctx, agentId: string) {
  const { results } = await c.env.DB.prepare(
    `SELECT replay_code, score, max_tile, move_count, finished_at FROM games
     WHERE agent_id = ?1 AND status != 'live' ORDER BY score DESC LIMIT 10`,
  )
    .bind(agentId)
    .all<{ replay_code: string; score: number; max_tile: number; move_count: number; finished_at: number }>();
  return results.map((r) => ({ replayCode: r.replay_code, score: r.score, maxTile: r.max_tile, moveCount: r.move_count, finishedAt: r.finished_at }));
}

/**
 * Have the platform play a game with a registered push agent (it calls the
 * agent's /decide endpoint each move). Requires the agent's API key.
 */
agents.post('/:ref/run', async (c) => {
  await rateLimit(c, 'CREATE_LIMITER');
  const key = bearer(c);
  if (!key) throw new ApiError('UNAUTHORIZED', 'send the agent API key as Authorization: Bearer <apiKey>');
  const agent = await agentByKey(c.env.DB, key);
  const ref = c.req.param('ref');
  if (!agent || (agent.id !== ref.toUpperCase() && agent.name !== ref)) throw new ApiError('UNAUTHORIZED', 'API key does not belong to this agent');
  if (!agent.endpoint) throw new ApiError('BAD_REQUEST', 'agent has no endpoint registered; it can only play by calling the API (pull mode)');
  const b = await body(c);
  const state = await createLiveGame(c, {
    seed: optInt(b.seed, 'seed', 0, 0xffffffff),
    source: 'driver',
    player: { kind: 'agent', agentId: agent.id, name: agent.name, version: agent.version },
    driver: {
      type: 'remote',
      endpoint: agent.endpoint,
      timeoutMs: optInt(b.timeoutMs, 'timeoutMs', 250, 15000) ?? 5000,
      maxMoves: optInt(b.maxMoves, 'maxMoves', 1, 100000) ?? 100000,
      delayMs: optInt(b.delayMs, 'delayMs', 0, 5000) ?? 0,
    },
  });
  return c.json(state, 201);
});
