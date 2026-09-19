/**
 * Server-side agent drivers: how a Durable Object obtains moves when the
 * platform (rather than an external client) is driving a game.
 *
 *  - builtin: lightweight TypeScript agents run in-process. Search depth is
 *    capped so a batch stays well inside Workers CPU limits.
 *  - remote:  the push protocol (spec/AGENT_PROTOCOL.md) — POST /decide.
 */
import { type Direction, type Game, SPEC_VERSION, parseDirection } from '@g2048/engine';
import { type Agent, type DecisionMetrics, createBuiltinAgent, toAgentRequest } from '@g2048/engine/ai';
import { ApiError } from './errors.ts';

export type DriverSpec =
  | { type: 'builtin'; agent: 'random' | 'greedy' | 'expectimax'; config?: Record<string, unknown> }
  | { type: 'remote'; endpoint: string; timeoutMs?: number };

export interface DriverDecision {
  moves: Direction[];
  metrics?: DecisionMetrics | Record<string, number>;
}

export interface Driver {
  readonly remote: boolean;
  decide(game: Game, gameId: string): Promise<DriverDecision>;
}

/** Keep server-side search cheap: depth ≤ 2, deterministic. */
export function sanitizeBuiltinConfig(agent: string, config: Record<string, unknown> = {}): Record<string, unknown> {
  if (agent !== 'expectimax') return {};
  const depth = typeof config.depth === 'number' ? Math.max(1, Math.min(2, Math.floor(config.depth))) : 2;
  return { ...config, depth, timeBudgetMs: 0, ttBits: 16 };
}

export function validateEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError('BAD_REQUEST', 'endpoint must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw new ApiError('BAD_REQUEST', 'endpoint must use https');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/.test(url.hostname)) {
    throw new ApiError('BAD_REQUEST', 'endpoint must be publicly reachable');
  }
  return url;
}

export function createDriver(spec: DriverSpec, seed: number): Driver {
  if (spec.type === 'builtin') {
    const agent: Agent = createBuiltinAgent(spec.agent, sanitizeBuiltinConfig(spec.agent, spec.config));
    agent.reset?.({ seed, specVersion: SPEC_VERSION });
    return {
      remote: false,
      async decide(game, gameId) {
        const d = await agent.decide({ board: game.board, score: game.score, moveCount: game.moveCount, meta: { seed, specVersion: SPEC_VERSION, gameId } });
        return { moves: [d.move], metrics: d.metrics };
      },
    };
  }
  const endpoint = validateEndpoint(spec.endpoint).toString();
  const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 5000, 250), 15000);
  return {
    remote: true,
    async decide(game, gameId) {
      const body = toAgentRequest({ board: game.board, score: game.score, moveCount: game.moveCount, meta: { seed, specVersion: SPEC_VERSION, gameId } });
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'g2048-platform/1 (+agent-protocol v1)' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new ApiError('AGENT_UNREACHABLE', `agent endpoint failed: ${(e as Error).message}`);
      }
      if (!res.ok) throw new ApiError('AGENT_UNREACHABLE', `agent endpoint returned HTTP ${res.status}`);
      const j = (await res.json().catch(() => null)) as { move?: string; moves?: string[]; metrics?: Record<string, number> } | null;
      if (!j) throw new ApiError('AGENT_UNREACHABLE', 'agent endpoint returned invalid JSON');
      const raw = j.moves ?? (j.move !== undefined ? [j.move] : []);
      if (raw.length === 0) throw new ApiError('AGENT_UNREACHABLE', 'agent response had no move');
      return { moves: raw.slice(0, 64).map((m) => parseDirection(m)), metrics: j.metrics };
    },
  };
}
