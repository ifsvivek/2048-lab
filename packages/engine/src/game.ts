/** SPEC §6 — the game lifecycle. */
import {
  type Board,
  type Direction,
  type Spawn,
  DIRECTION_LETTERS,
  boardToHex,
  emptyBoard,
  isOver,
  maxTile,
  moveInPlace,
  spawn,
} from './board.ts';
import { boardHash, hashHex, historyStep } from './hash.ts';
import { Rng, type RngState } from './rng.ts';

export const SPEC_VERSION = 1;

export interface GameSnapshot {
  seed: number;
  board: string;
  score: number;
  moveCount: number;
  maxTile: number;
  over: boolean;
  historyHash: string;
}

export interface StepResult {
  dir: Direction;
  gained: number;
  spawn: Spawn | null;
}

export class Game {
  readonly seed: number;
  board: Board;
  score = 0;
  moveCount = 0;
  private rng: Rng;
  private hash: number;
  private moveLetters: string[] = [];

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = Rng.fromSeed(this.seed);
    this.board = emptyBoard();
    spawn(this.board, this.rng);
    spawn(this.board, this.rng);
    this.hash = boardHash(this.board);
  }

  /** Apply a move. Returns null (and changes nothing) if the move is invalid. */
  apply(dir: Direction): StepResult | null {
    const gained = moveInPlace(this.board, dir);
    if (gained < 0) return null;
    this.score += gained;
    this.moveCount += 1;
    const s = spawn(this.board, this.rng);
    this.hash = historyStep(this.hash, this.board, dir);
    this.moveLetters.push(DIRECTION_LETTERS[dir]);
    return { dir, gained, spawn: s };
  }

  get over(): boolean {
    return isOver(this.board);
  }

  get historyHash(): string {
    return hashHex(this.hash);
  }

  get moves(): string {
    return this.moveLetters.join('');
  }

  rngState(): RngState {
    return this.rng.state();
  }

  snapshot(): GameSnapshot {
    return {
      seed: this.seed,
      board: boardToHex(this.board),
      score: this.score,
      moveCount: this.moveCount,
      maxTile: maxTile(this.board),
      over: this.over,
      historyHash: this.historyHash,
    };
  }
}
