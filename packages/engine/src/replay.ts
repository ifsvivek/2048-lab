/** SPEC §8 — replay format, verification and history reconstruction. */
import { type Board, type Direction, type Spawn, DIRECTION_LETTERS } from './board.ts';
import { Game, type GameSnapshot, SPEC_VERSION } from './game.ts';

export interface AgentInfo {
  id?: string;
  name: string;
  version?: string;
  config?: Record<string, unknown>;
}

export interface RuntimeInfo {
  language: string;
  runtime?: string;
  version?: string;
  platform?: string;
}

export interface Replay {
  specVersion: number;
  gameId?: string;
  replayCode?: string;
  seed: number;
  moves: string;
  final: Omit<GameSnapshot, 'seed'>;
  /** per-move decision time in microseconds */
  timing?: number[];
  playerKind?: 'human' | 'agent';
  agent?: AgentInfo;
  runtime?: RuntimeInfo;
  startedAt?: number;
  finishedAt?: number;
}

export type ReplayErrorCode = 'INVALID_MOVE_AT' | 'BAD_LETTER' | 'SPEC_VERSION' | 'FINAL_MISMATCH';

export class ReplayError extends Error {
  readonly code: ReplayErrorCode;
  readonly moveIndex?: number;
  constructor(code: ReplayErrorCode, message: string, moveIndex?: number) {
    super(message);
    this.code = code;
    this.moveIndex = moveIndex;
  }
}

export function letterToDirection(ch: string, at: number): Direction {
  const d = DIRECTION_LETTERS.indexOf(ch);
  if (d < 0) throw new ReplayError('BAD_LETTER', `bad move letter '${ch}' at ${at}`, at);
  return d as Direction;
}

/** Re-simulate `moves` from `seed`. Throws ReplayError on an invalid move. */
export function simulate(seed: number, moves: string): Game {
  const game = new Game(seed);
  for (let i = 0; i < moves.length; i++) {
    const dir = letterToDirection(moves[i], i);
    if (!game.apply(dir)) {
      throw new ReplayError('INVALID_MOVE_AT', `INVALID_MOVE_AT ${i}`, i);
    }
  }
  return game;
}

/** Verify a replay; returns the authoritative final snapshot. */
export function verifyReplay(replay: Pick<Replay, 'specVersion' | 'seed' | 'moves'> & { final?: Partial<GameSnapshot> }): GameSnapshot {
  if (replay.specVersion !== SPEC_VERSION) {
    throw new ReplayError('SPEC_VERSION', `unsupported specVersion ${replay.specVersion}`);
  }
  const snap = simulate(replay.seed, replay.moves).snapshot();
  const f = replay.final;
  if (f) {
    for (const key of ['board', 'score', 'moveCount', 'historyHash'] as const) {
      if (f[key] !== undefined && f[key] !== snap[key]) {
        throw new ReplayError('FINAL_MISMATCH', `final.${key} mismatch: claimed ${f[key]}, actual ${snap[key]}`);
      }
    }
  }
  return snap;
}

export interface HistoryFrame {
  board: Board;
  score: number;
  /** move that produced this frame (null for the initial frame) */
  dir: Direction | null;
  gained: number;
  spawn: Spawn | null;
}

/** Full board history — frame 0 is the initial board, frame k follows move k. */
export function reconstruct(seed: number, moves: string): HistoryFrame[] {
  const game = new Game(seed);
  const frames: HistoryFrame[] = [{ board: game.board.slice(), score: 0, dir: null, gained: 0, spawn: null }];
  for (let i = 0; i < moves.length; i++) {
    const dir = letterToDirection(moves[i], i);
    const step = game.apply(dir);
    if (!step) throw new ReplayError('INVALID_MOVE_AT', `INVALID_MOVE_AT ${i}`, i);
    frames.push({ board: game.board.slice(), score: game.score, dir, gained: step.gained, spawn: step.spawn });
  }
  return frames;
}
