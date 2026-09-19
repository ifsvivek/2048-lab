/**
 * /v1/replays — upload finished local games, fetch replays by code or game ID,
 * and spectate live games by replay code.
 */
import { Hono } from 'hono';
import {
  ReplayError,
  SPEC_VERSION,
  classifyGameRef,
  formatReplayCode,
  generateReplayCode,
  isUlid,
  normalizeReplayCode,
  ulid,
  verifyReplay,
} from '@g2048/engine';
import { type GameRecord, getGameRow, rollupStatements, rowToReplay, upsertGame } from '../lib/db.ts';
import { isClientId } from '../lib/analytics.ts';
import { ApiError } from '../lib/errors.ts';
import { type AppEnv, body, edgeCached, optInt, optObj, optStr, rateLimit, rpc } from '../lib/http.ts';
import type { LiveReplay } from '../do/game-session.ts';
import { gameStub } from './games.ts';

export const replays = new Hono<AppEnv>();

/**
 * Upload a finished game played locally (browser, CLI, notebook). The server
 * re-simulates it from (seed, moves) — client-reported scores are never trusted.
 * Idempotent on gameId: re-uploading the same game returns the stored replay.
 */
replays.post('/', async (c) => {
  await rateLimit(c, 'WRITE_LIMITER');
  const b = await body(c);
  const specVersion = optInt(b.specVersion, 'specVersion', 1, 1000) ?? SPEC_VERSION;
  const seed = optInt(b.seed, 'seed', 0, 0xffffffff);
  if (seed === undefined) throw new ApiError('BAD_REQUEST', 'seed is required');
  const moves = optStr(b.moves, 'moves', Number(c.env.MAX_MOVES_PER_GAME) || 100000);
  if (moves === undefined) throw new ApiError('BAD_REQUEST', 'moves is required (string of U/D/L/R)');
  const min = Number(c.env.MIN_STORE_MOVES) || 10;
  if (moves.length < min) throw new ApiError('NOT_WORTH_STORING', `games shorter than ${min} moves are not stored`);

  const gameId = (optStr(b.gameId, 'gameId', 26) ?? '').toUpperCase();
  if (gameId && !isUlid(gameId)) throw new ApiError('BAD_REQUEST', 'gameId must be a ULID');
  const requestedCode = b.replayCode ? normalizeReplayCode(String(b.replayCode)) : null;
  if (b.replayCode && !requestedCode) throw new ApiError('BAD_REQUEST', 'replayCode is not a valid code');

  let final;
  try {
    final = verifyReplay({ specVersion, seed, moves, final: optObj(b.final, 'final') });
  } catch (e) {
    if (e instanceof ReplayError) throw new ApiError('REPLAY_INVALID', e.message, { reason: e.code, moveIndex: e.moveIndex ?? null });
    throw e;
  }

  if (gameId) {
    const existing = await getGameRow(c.env.DB, gameId);
    if (existing) {
      if (existing.moves === moves && existing.seed === seed) return c.json(rowToReplay(existing));
      throw new ApiError('CONFLICT', 'a different game with this gameId already exists');
    }
  }

  // Keep the client's pre-generated code when free; otherwise issue a new one.
  let replayCode = requestedCode ? formatReplayCode(requestedCode) : generateReplayCode();
  const taken = await c.env.DB.prepare('SELECT 1 FROM games WHERE replay_code = ?1').bind(replayCode).first();
  if (taken) replayCode = generateReplayCode();

  const player = optObj(b.agent, 'agent');
  const timing = Array.isArray(b.timing) ? (b.timing as unknown[]).slice(0, moves.length).map((t) => (typeof t === 'number' && t >= 0 ? Math.round(t) : 0)) : null;
  const now = Date.now();
  const rec: GameRecord = {
    id: gameId || ulid(),
    replayCode,
    status: final.over ? 'over' : 'abandoned',
    source: 'upload',
    seed,
    moves,
    timing,
    score: final.score,
    maxTile: final.maxTile,
    moveCount: final.moveCount,
    finalBoard: final.board,
    historyHash: final.historyHash,
    playerKind: b.playerKind === 'agent' ? 'agent' : 'human',
    agentId: null,
    agentName: player ? (optStr(player.name, 'agent.name', 64) ?? null) : null,
    agentVersion: player ? (optStr(player.version, 'agent.version', 32) ?? null) : null,
    agentConfig: player ? (optObj(player.config, 'agent.config') ?? null) : null,
    runtime: optObj(b.runtime, 'runtime') ?? null,
    startedAt: optInt(b.startedAt, 'startedAt', 0, now + 60_000) ?? now,
    finishedAt: optInt(b.finishedAt, 'finishedAt', 0, now + 60_000) ?? now,
    // Anonymous browser identifiers (random tokens; no personal data).
    playerId: isClientId(b.playerId) ? b.playerId : null,
    sessionId: isClientId(b.sessionId) ? b.sessionId : null,
  };
  const stats = optObj(b.stats, 'stats');
  const facts = {
    agentKind: rec.playerKind === 'agent' ? 'browser' : null,
    depthSum: typeof stats?.depthSum === 'number' ? Math.max(0, Math.round(stats.depthSum)) : 0,
    depthSamples: typeof stats?.depthSamples === 'number' ? Math.max(0, Math.round(stats.depthSamples)) : 0,
  };
  await c.env.DB.batch([upsertGame(c.env.DB, rec), ...rollupStatements(c.env.DB, rec, facts)]);
  const row = await getGameRow(c.env.DB, rec.id);
  return c.json(rowToReplay(row!), 201);
});

replays.get('/:ref', async (c) => {
  const ref = c.req.param('ref');
  const kind = classifyGameRef(ref);
  if (!kind) throw new ApiError('REPLAY_NOT_FOUND', 'not a valid replay code or game ID');
  const row = await getGameRow(c.env.DB, ref);
  if (!row) throw new ApiError('REPLAY_NOT_FOUND', 'No game with this replay code or game ID.');
  if (row.status === 'live') {
    // RPC typing can't express Record<string, unknown>; the runtime value is the plain object.
    const live = (await rpc(gameStub(c, row.id).getLiveReplay())) as unknown as LiveReplay | null;
    if (!live) throw new ApiError('REPLAY_NOT_FOUND', 'live game not available');
    return c.json(
      {
        specVersion: SPEC_VERSION,
        // A live game's ID is its control handle, so it is withheld until the game ends.
        gameId: null,
        replayCode: row.replay_code,
        status: 'live',
        source: live.source,
        seed: row.seed,
        moves: live.moves,
        final: { board: live.state.boardHex, score: live.state.score, moveCount: live.state.moveNumber, maxTile: live.state.maxTile, over: false, historyHash: live.state.historyHash },
        timing: live.timing,
        playerKind: row.player_kind,
        agent: row.agent_name ? { id: row.agent_id ?? undefined, name: row.agent_name, version: row.agent_version ?? undefined, config: live.agentConfig ?? undefined } : undefined,
        runtime: live.runtime ?? undefined,
        startedAt: row.started_at,
      },
      200,
      { 'cache-control': 'no-store' },
    );
  }
  // Finished replays are immutable: cache them at the edge for a year.
  return edgeCached(c, 31_536_000, async () => rowToReplay(row));
});

/** Spectate a live game over WebSocket, addressed by its public replay code. */
replays.get('/:ref/live', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new ApiError('BAD_REQUEST', 'expected a WebSocket upgrade');
  const code = normalizeReplayCode(c.req.param('ref'));
  if (!code) throw new ApiError('REPLAY_NOT_FOUND', 'not a valid replay code');
  const row = await c.env.DB.prepare("SELECT id, status FROM games WHERE replay_code = ?1").bind(formatReplayCode(code)).first<{ id: string; status: string }>();
  if (!row) throw new ApiError('REPLAY_NOT_FOUND', 'No game with this replay code.');
  if (row.status !== 'live') throw new ApiError('GAME_OVER', 'This game has finished; fetch the replay instead.');
  return gameStub(c, row.id).fetch(c.req.raw);
});
