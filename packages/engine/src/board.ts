/**
 * SPEC §1–§3, §5 — board encoding, line merge, moves and spawning.
 * A board is a Uint8Array(16) of exponents, row-major.
 */
import type { Rng } from './rng.ts';

export type Board = Uint8Array;

export const UP = 0;
export const DOWN = 1;
export const LEFT = 2;
export const RIGHT = 3;
export type Direction = 0 | 1 | 2 | 3;
export const DIRECTIONS: readonly Direction[] = [UP, DOWN, LEFT, RIGHT];
export const DIRECTION_LETTERS = 'UDLR';
export const DIRECTION_NAMES = ['up', 'down', 'left', 'right'] as const;
export type DirectionName = (typeof DIRECTION_NAMES)[number];

/** LINES[dir][line] = the four cell indices, starting at the edge tiles slide toward. */
export const LINES: readonly (readonly (readonly number[])[])[] = [
  [0, 1, 2, 3].map((c) => [c, 4 + c, 8 + c, 12 + c]),
  [0, 1, 2, 3].map((c) => [12 + c, 8 + c, 4 + c, c]),
  [0, 1, 2, 3].map((r) => [4 * r, 4 * r + 1, 4 * r + 2, 4 * r + 3]),
  [0, 1, 2, 3].map((r) => [4 * r + 3, 4 * r + 2, 4 * r + 1, 4 * r]),
];

const HEX = '0123456789abcdefghijklmnopqrstuvwxyz';

export function emptyBoard(): Board {
  return new Uint8Array(16);
}

export function boardToHex(board: Board): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += HEX[board[i]];
  return s;
}

export function boardFromHex(hex: string): Board {
  if (hex.length !== 16) throw new Error(`boardHex must be 16 chars, got ${hex.length}`);
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const v = HEX.indexOf(hex[i].toLowerCase());
    if (v < 0) throw new Error(`invalid boardHex character '${hex[i]}'`);
    b[i] = v;
  }
  return b;
}

/** Board as tile values (0 for empty) in a 4×4 matrix — convenient for agents and APIs. */
export function boardToMatrix(board: Board): number[][] {
  const m: number[][] = [];
  for (let r = 0; r < 4; r++) {
    const row: number[] = [];
    for (let c = 0; c < 4; c++) {
      const e = board[r * 4 + c];
      row.push(e === 0 ? 0 : 2 ** e);
    }
    m.push(row);
  }
  return m;
}

export function boardsEqual(a: Board, b: Board): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function maxExponent(board: Board): number {
  let m = 0;
  for (let i = 0; i < 16; i++) if (board[i] > m) m = board[i];
  return m;
}

export function maxTile(board: Board): number {
  const e = maxExponent(board);
  return e === 0 ? 0 : 2 ** e;
}

export function emptyCount(board: Board): number {
  let n = 0;
  for (let i = 0; i < 16; i++) if (board[i] === 0) n++;
  return n;
}

const lineBuf = new Uint8Array(4);
const resBuf = new Uint8Array(4);

/**
 * Apply `dir` to `board` in place. Returns the score gained, or -1 if the
 * move is invalid (in which case the board is untouched).
 */
export function moveInPlace(board: Board, dir: Direction): number {
  const lines = LINES[dir];
  let gained = 0;
  let changed = false;
  for (let l = 0; l < 4; l++) {
    const idx = lines[l];
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const v = board[idx[k]];
      if (v !== 0) lineBuf[n++] = v;
    }
    resBuf.fill(0);
    let out = 0;
    let i = 0;
    while (i < n) {
      if (i + 1 < n && lineBuf[i] === lineBuf[i + 1]) {
        const e = lineBuf[i] + 1;
        resBuf[out++] = e;
        gained += 2 ** e;
        i += 2;
      } else {
        resBuf[out++] = lineBuf[i];
        i += 1;
      }
    }
    // Lines are independent, so an unchanged line is simply left alone.
    for (let k = 0; k < 4; k++) {
      if (board[idx[k]] !== resBuf[k]) {
        board[idx[k]] = resBuf[k];
        changed = true;
      }
    }
  }
  return changed ? gained : -1;
}

export interface MoveResult {
  board: Board;
  gained: number;
  changed: boolean;
}

export function move(board: Board, dir: Direction): MoveResult {
  const b = board.slice();
  const g = moveInPlace(b, dir);
  return g < 0 ? { board, gained: 0, changed: false } : { board: b, gained: g, changed: true };
}

export function canMove(board: Board, dir: Direction): boolean {
  for (const idx of LINES[dir]) {
    for (let k = 1; k < 4; k++) {
      const prev = board[idx[k - 1]];
      const cur = board[idx[k]];
      if (cur !== 0 && (prev === 0 || prev === cur)) return true;
    }
  }
  return false;
}

export function validMoves(board: Board): Direction[] {
  return DIRECTIONS.filter((d) => canMove(board, d));
}

export function isOver(board: Board): boolean {
  for (let d = 0; d < 4; d++) if (canMove(board, d as Direction)) return false;
  return true;
}

export interface Spawn {
  index: number;
  exponent: number;
}

/** SPEC §5. Returns the spawned tile, or null if the board is full. */
export function spawn(board: Board, rng: Rng): Spawn | null {
  const empties: number[] = [];
  for (let i = 0; i < 16; i++) if (board[i] === 0) empties.push(i);
  if (empties.length === 0) return null;
  const index = empties[rng.below(empties.length)];
  const exponent = rng.below(10) === 0 ? 2 : 1;
  board[index] = exponent;
  return { index, exponent };
}

/** Per-tile motion for UI animation: where each source tile ends up. */
export interface TileMotion {
  from: number;
  to: number;
  exponent: number;
  /** true for both tiles that combine into a merged tile */
  merged: boolean;
}

export function moveMotions(board: Board, dir: Direction): TileMotion[] {
  const motions: TileMotion[] = [];
  for (const idx of LINES[dir]) {
    const tiles: number[] = [];
    for (let k = 0; k < 4; k++) if (board[idx[k]] !== 0) tiles.push(idx[k]);
    let out = 0;
    let i = 0;
    while (i < tiles.length) {
      const a = tiles[i];
      if (i + 1 < tiles.length && board[a] === board[tiles[i + 1]]) {
        motions.push({ from: a, to: idx[out], exponent: board[a], merged: true });
        motions.push({ from: tiles[i + 1], to: idx[out], exponent: board[a], merged: true });
        i += 2;
      } else {
        motions.push({ from: a, to: idx[out], exponent: board[a], merged: false });
        i += 1;
      }
      out++;
    }
  }
  return motions;
}

export function parseDirection(input: string | number): Direction {
  if (typeof input === 'number') {
    if (input === 0 || input === 1 || input === 2 || input === 3) return input;
    throw new Error(`invalid direction ${input}`);
  }
  const s = input.trim().toLowerCase();
  const byName = DIRECTION_NAMES.indexOf(s as DirectionName);
  if (byName >= 0) return byName as Direction;
  const byLetter = DIRECTION_LETTERS.indexOf(s.toUpperCase());
  if (s.length === 1 && byLetter >= 0) return byLetter as Direction;
  throw new Error(`invalid direction '${input}'`);
}
