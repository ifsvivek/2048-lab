/**
 * MCP tools, resources and prompts for the 2048 platform.
 *
 * Compatibility policy (docs/MCP.md): tool names and required inputs are
 * stable within server major version 1. New tools and new *optional* inputs
 * or output fields may be added at any time; clients must ignore unknown
 * output fields. Breaking changes ship under a new endpoint (/v2/mcp).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import { z } from 'zod';
import { ApiClient, type ApiErrorBody, PlatformError } from './api.ts';

export const SERVER_INFO = { name: 'g2048', title: '2048 AI Platform', version: '1.0.0' } as const;

const Move = z.enum(['up', 'down', 'left', 'right']);

/** Trimmed, decision-ready game state (drops presentation-only fields). */
function agentState(s: Record<string, any>) {
  return {
    gameId: s.gameId,
    replayCode: s.replayCode,
    seed: s.seed,
    status: s.status,
    board: s.board,
    score: s.score,
    moveNumber: s.moveNumber,
    maxTile: s.maxTile,
    validMoves: s.validMoves,
    lastMove: s.lastMove ?? null,
    historyHash: s.historyHash,
    ...(s.applied !== undefined ? { applied: s.applied, rejected: s.rejected ?? null } : {}),
  };
}

const GameState = {
  gameId: z.string().describe('Control handle for this game; pass it to make_move / get_game.'),
  replayCode: z.string().describe('Public share/spectate code, e.g. A7KF-29LM-XQ4P.'),
  seed: z.number().int(),
  status: z.enum(['active', 'over', 'abandoned']),
  board: z.array(z.array(z.number().int())).describe('board[row][col] tile values, row 0 on top, 0 = empty.'),
  score: z.number().int(),
  moveNumber: z.number().int(),
  maxTile: z.number().int(),
  validMoves: z.array(Move).describe('Moves that change the board. Empty when the game is over.'),
  lastMove: z
    .object({ move: z.string(), gained: z.number(), spawn: z.object({ row: z.number(), col: z.number(), value: z.number() }).nullable() })
    .nullable(),
  historyHash: z.string(),
  applied: z.number().int().optional(),
  rejected: z.object({ index: z.number(), move: z.string(), reason: z.string() }).nullable().optional(),
};

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function fail(e: unknown): ToolResult {
  const body: ApiErrorBody =
    e instanceof PlatformError ? e.body : { error: true, code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
  // Invalid moves carry the current state so the agent can recover without another call.
  const details = body.details as { state?: Record<string, unknown> } | undefined;
  const out = { ...body, ...(details?.state ? { state: agentState(details.state), details: undefined } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: true };
}

async function run(fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

const RULES = `# 2048 rules (spec v1)
- 4x4 board; board[row][col] holds tile values (0 = empty); row 0 is the top.
- A move (up/down/left/right) slides every tile toward that edge. Two equal adjacent tiles merge once per move into their sum, which is added to the score.
- A move is valid only if it changes the board (see validMoves). Invalid moves are rejected with INVALID_MOVE and do not count.
- After every valid move one tile spawns in a random empty cell: 2 (90%) or 4 (10%). Spawns are deterministic given the seed, so a game is fully reproducible from (seed, moves).
- The game is over when no move is valid (status "over"). Goal: maximise score / reach 2048 and beyond.
- Strategy hints: keep the largest tile in a corner, keep rows monotonic, keep empty cells available, avoid the move that pulls the big tile out of its corner.`;

export function buildServer(api: ApiClient): McpServer {
  const server = new McpServer(SERVER_INFO, {
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    instructions:
      'Play and analyse deterministic 2048 games. Typical loop: create_game → repeat make_move with the returned gameId (choose from validMoves) until status is "over" → get_replay with the replayCode. Every response contains the full state needed for the next decision. Errors are JSON objects {error:true, code, message}.',
  });

  // ------------------------------------------------------------ gameplay
  server.registerTool(
    'create_game',
    {
      title: 'Create game',
      description: 'Start a new deterministic 2048 game. Returns gameId (control handle), replayCode (public), seed, board, score, status and validMoves.',
      inputSchema: {
        seed: z.number().int().min(0).max(4294967295).optional().describe('uint32 seed; omit for a random one. Same seed + same moves = same game.'),
        agentName: z.string().max(64).optional().describe('Name to attribute the game to (e.g. "claude-code-greedy").'),
        agentVersion: z.string().max(32).optional(),
      },
      outputSchema: GameState,
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ seed, agentName, agentVersion }) =>
      run(async () =>
        agentState(
          await api.call('POST', '/v1/games', { seed, source: 'mcp', agent: { name: agentName ?? 'mcp-agent', version: agentVersion } }, true),
        ),
      ),
  );

  server.registerTool(
    'get_game',
    {
      title: 'Get game',
      description: 'Fetch the current state of a game by gameId.',
      inputSchema: { gameId: z.string().describe('The gameId returned by create_game.') },
      outputSchema: GameState,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ gameId }) => run(async () => agentState(await api.call('GET', `/v1/games/${encodeURIComponent(gameId)}`))),
  );

  server.registerTool(
    'make_move',
    {
      title: 'Make move',
      description: 'Submit one move. Returns the complete updated state (board after the new tile spawned). An invalid move returns error INVALID_MOVE together with the unchanged state.',
      inputSchema: { gameId: z.string(), move: Move },
      outputSchema: GameState,
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ gameId, move }) => run(async () => agentState(await api.call('POST', `/v1/games/${encodeURIComponent(gameId)}/moves`, { move }))),
  );

  server.registerTool(
    'make_moves',
    {
      title: 'Make several moves',
      description: 'Submit up to 50 moves in order (fewer round trips). Stops at the first invalid move; `applied` says how many were played and `rejected` which one stopped the batch. Note you cannot see spawns between batched moves.',
      inputSchema: { gameId: z.string(), moves: z.array(Move).min(1).max(50) },
      outputSchema: GameState,
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ gameId, moves }) => run(async () => agentState(await api.call('POST', `/v1/games/${encodeURIComponent(gameId)}/moves`, { moves }))),
  );

  server.registerTool(
    'resign_game',
    {
      title: 'Resign game',
      description: 'End an active game now. It is stored (if long enough) and its replay becomes available.',
      inputSchema: { gameId: z.string() },
      outputSchema: GameState,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ gameId }) => run(async () => agentState(await api.call('POST', `/v1/games/${encodeURIComponent(gameId)}/resign`))),
  );

  // ------------------------------------------------------------ replays
  server.registerTool(
    'get_replay',
    {
      title: 'Get replay',
      description: 'Replay metadata and full move history for a finished (or live) game, by replayCode or gameId. moves is a string of U/D/L/R letters; replaying it from seed reproduces the game exactly.',
      inputSchema: {
        replayCode: z.string().optional().describe('e.g. A7KF-29LM-XQ4P'),
        gameId: z.string().optional(),
        includeTiming: z.boolean().optional().describe('Include per-move decision times in µs (default false).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ replayCode, gameId, includeTiming }) =>
      run(async () => {
        const ref = replayCode ?? gameId;
        if (!ref) throw new PlatformError({ error: true, code: 'BAD_REQUEST', message: 'provide replayCode or gameId' });
        const r = await api.call<Record<string, any>>('GET', `/v1/replays/${encodeURIComponent(ref)}`);
        if (!includeTiming) delete r.timing;
        return { ...r, moveHistory: { encoding: 'U=up D=down L=left R=right', count: String(r.moves).length } };
      }),
  );

  server.registerTool(
    'list_live_games',
    {
      title: 'List live games',
      description: 'Games currently being played on the platform (by replay code, for spectating).',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ limit }) => run(() => api.call('GET', `/v1/games?limit=${limit ?? 20}`)),
  );

  // ------------------------------------------------------- leaderboards
  server.registerTool(
    'list_leaderboard',
    {
      title: 'Leaderboard',
      description: 'Top scores (with replay codes) and top agents.',
      inputSchema: {
        kind: z.enum(['all', 'human', 'agent']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ kind, limit }) => run(() => api.call('GET', `/v1/leaderboard?kind=${kind ?? 'all'}&limit=${limit ?? 25}`)),
  );

  server.registerTool(
    'get_agent_stats',
    {
      title: 'Agent statistics',
      description: 'Statistics for one agent (registered ID/name or builtin/expectimax, builtin/greedy, builtin/random): games, average/best score, reach rates, top games.',
      inputSchema: { agent: z.string().describe('Agent ID, name, or builtin/<name>.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ agent }) => run(() => api.call('GET', `/v1/agents/${encodeURIComponent(agent)}`)),
  );

  server.registerTool(
    'get_platform_stats',
    {
      title: 'Platform statistics',
      description: 'Aggregate statistics: games played, average/best scores and tile reach rates for humans and agents.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(() => api.call('GET', '/v1/stats')),
  );

  // ---------------------------------------------------------- benchmarks
  server.registerTool(
    'run_benchmark',
    {
      title: 'Run benchmark',
      description:
        'Run a server-side benchmark session: the platform plays `games` games on seeds seedStart.. with the given agent (builtin/greedy, builtin/expectimax, or a registered push agent — that needs the agent API key as the MCP connection Authorization header). With wait=true, waits up to ~25 s and returns results; otherwise returns benchmarkId to poll with get_benchmark.',
      inputSchema: {
        agent: z.string().optional().describe('builtin/greedy (default), builtin/expectimax, or a registered agent ID/name.'),
        games: z.number().int().min(1).max(20).optional(),
        seedStart: z.number().int().min(0).max(4294967295).optional(),
        maxMoves: z.number().int().min(1).max(20000).optional(),
        depth: z.number().int().min(1).max(2).optional().describe('Search depth for builtin/expectimax (server cap 2).'),
        wait: z.boolean().optional(),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ agent, games, seedStart, maxMoves, depth, wait }) =>
      run(async () => {
        let s = await api.call<Record<string, any>>(
          'POST',
          '/v1/benchmarks/sessions',
          { agent: agent ?? 'builtin/greedy', games: games ?? 3, seedStart: seedStart ?? 1, maxMoves: maxMoves ?? 5000, config: depth ? { depth } : undefined },
          true,
        );
        if (wait) {
          const deadline = Date.now() + 25_000;
          while (s.status === 'running' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1000));
            s = await api.call('GET', `/v1/benchmarks/sessions/${s.benchmarkId}`);
          }
        }
        return s;
      }),
  );

  server.registerTool(
    'get_benchmark',
    {
      title: 'Get benchmark',
      description: 'Status and results of a benchmark session started with run_benchmark.',
      inputSchema: { benchmarkId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ benchmarkId }) => run(() => api.call('GET', `/v1/benchmarks/sessions/${encodeURIComponent(benchmarkId)}`)),
  );

  server.registerTool(
    'compare_runtimes',
    {
      title: 'Compare runtimes',
      description: 'Cross-language benchmark comparison (TypeScript, Rust, Go, Python) for one shared suite: best/latest throughput, latency, memory and score per implementation.',
      inputSchema: {
        suite: z.string().optional().describe('Suite id, e.g. engine-random-1k (default), expectimax-d2-10, expectimax-d3-opening.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ suite }) => run(() => api.call('GET', `/v1/benchmarks/compare?suite=${encodeURIComponent(suite ?? 'engine-random-1k')}`)),
  );

  server.registerTool(
    'list_benchmark_suites',
    {
      title: 'Benchmark suites',
      description: 'The shared, reproducible benchmark suites and their expected checksums.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(() => api.call('GET', '/v1/benchmarks/suites')),
  );

  server.registerTool(
    'get_rules',
    {
      title: 'Game rules',
      description: 'The exact game rules, move semantics and determinism guarantees.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: 'text', text: RULES }] }),
  );

  // ------------------------------------------------ resources & prompts
  server.registerResource(
    'rules',
    'g2048://rules',
    { title: '2048 rules', description: 'Game rules and determinism guarantees', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: RULES }] }),
  );

  server.registerPrompt(
    'play_2048',
    {
      title: 'Play a game of 2048',
      description: 'Instructions for playing a full game with the tools.',
      argsSchema: { strategy: z.string().optional().describe('Optional strategy to follow, e.g. "corner" or "expectimax-lite".') },
    },
    ({ strategy }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Play one complete game of 2048 using the g2048 tools.\n1. Call create_game.\n2. Look at board and validMoves; choose a move${strategy ? ` using the "${strategy}" strategy` : ' (keep the largest tile in a corner, keep rows monotonic, maximise empty cells)'}.\n3. Call make_move with the gameId and the move. Repeat step 2–3 with the returned state until status is "over".\n4. Report the final score, max tile and replayCode.\n\n${RULES}`,
          },
        },
      ],
    }),
  );

  return server;
}
