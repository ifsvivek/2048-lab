/**
 * The public game-state shape returned by every endpoint that touches a game
 * (REST, WebSocket hello, MCP tools). It is self-sufficient: an agent can pick
 * its next move from this object alone.
 */
import {
  type Game,
  type Spawn,
  DIRECTION_NAMES,
  SPEC_VERSION,
  boardFromHex,
  boardToHex,
  boardToMatrix,
  maxTile,
  validMoves,
} from '@g2048/engine';

export type GameStatus = 'active' | 'over' | 'abandoned';

export interface PlayerInfo {
  kind: 'human' | 'agent';
  agentId?: string | null;
  name?: string | null;
  version?: string | null;
}

export interface LastMove {
  move: string;
  gained: number;
  spawn: { row: number; col: number; value: number } | null;
}

export interface PublicGameState {
  gameId: string;
  replayCode: string;
  seed: number;
  specVersion: number;
  status: GameStatus;
  board: number[][];
  boardHex: string;
  score: number;
  moveNumber: number;
  maxTile: number;
  validMoves: string[];
  lastMove: LastMove | null;
  historyHash: string;
  player: PlayerInfo;
  startedAt: number;
  finishedAt: number | null;
  /** URLs a client may want next; relative to the API origin */
  links: { self: string; replay: string; spectate: string };
}

export function spawnInfo(s: Spawn | null): LastMove['spawn'] {
  return s ? { row: Math.floor(s.index / 4), col: s.index % 4, value: 2 ** s.exponent } : null;
}

export function links(gameId: string, replayCode: string) {
  return {
    self: `/v1/games/${gameId}`,
    replay: `/v1/replays/${replayCode}`,
    spectate: `/v1/replays/${replayCode}/live`,
  };
}

export function stateFromGame(
  game: Game,
  meta: { gameId: string; replayCode: string; player: PlayerInfo; startedAt: number; finishedAt?: number | null; status?: GameStatus },
  lastMove: LastMove | null = null,
): PublicGameState {
  const over = game.over;
  return {
    gameId: meta.gameId,
    replayCode: meta.replayCode,
    seed: game.seed,
    specVersion: SPEC_VERSION,
    status: meta.status && meta.status !== 'active' ? meta.status : over ? 'over' : 'active',
    board: boardToMatrix(game.board),
    boardHex: boardToHex(game.board),
    score: game.score,
    moveNumber: game.moveCount,
    maxTile: maxTile(game.board),
    validMoves: over ? [] : validMoves(game.board).map((d) => DIRECTION_NAMES[d]),
    lastMove,
    historyHash: game.historyHash,
    player: meta.player,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt ?? null,
    links: links(meta.gameId, meta.replayCode),
  };
}

/** State of a finished game from its stored row (no re-simulation needed). */
export function stateFromRow(row: GameRow): PublicGameState {
  const board = boardFromHex(row.final_board ?? '0000000000000000');
  const status: GameStatus = row.status === 'live' ? 'active' : row.status;
  return {
    gameId: row.id,
    replayCode: row.replay_code,
    seed: row.seed,
    specVersion: row.spec_version,
    status,
    board: boardToMatrix(board),
    boardHex: boardToHex(board),
    score: row.score,
    moveNumber: row.move_count,
    maxTile: maxTile(board),
    validMoves: status === 'active' ? validMoves(board).map((d) => DIRECTION_NAMES[d]) : [],
    lastMove: null,
    historyHash: row.history_hash ?? '',
    player: { kind: row.player_kind, agentId: row.agent_id, name: row.agent_name, version: row.agent_version },
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    links: links(row.id, row.replay_code),
  };
}

export interface GameRow {
  id: string;
  replay_code: string;
  status: 'live' | 'over' | 'abandoned';
  source: string;
  spec_version: number;
  seed: number;
  moves: string;
  timing: string | null;
  score: number;
  max_tile: number;
  move_count: number;
  final_board: string | null;
  history_hash: string | null;
  player_kind: 'human' | 'agent';
  agent_id: string | null;
  agent_name: string | null;
  agent_version: string | null;
  agent_config: string | null;
  runtime: string | null;
  started_at: number;
  finished_at: number | null;
  created_at: number;
}
