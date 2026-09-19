/**
 * AI.md §1 — 64-bit bitboard represented as two uint32 halves:
 *   lo = rows 0–1 (cells 0–7), hi = rows 2–3 (cells 8–15), 4 bits per cell.
 * Moves use 65536-entry line tables; columns are gathered into line values and
 * scattered back through precomputed spread tables.
 */
import type { Board } from '../board.ts';

/** Slide toward the low nibble ("left" for rows, "up" for columns). */
export const LINE_TOWARD_LOW = new Uint16Array(65536);
/** Slide toward the high nibble ("right" for rows, "down" for columns). */
export const LINE_TOWARD_HIGH = new Uint16Array(65536);
/** A line value placed as column 0: nibble k goes to row k. */
const SPREAD_LO = new Uint32Array(65536);
const SPREAD_HI = new Uint32Array(65536);

function reverseLine(v: number): number {
  return ((v & 0xf) << 12) | (((v >> 4) & 0xf) << 8) | (((v >> 8) & 0xf) << 4) | ((v >> 12) & 0xf);
}

let built = false;

/**
 * Build the line tables. Deferred (rather than run at import) so that bundles
 * which merely import the module — e.g. a Worker that only replays games —
 * don't pay for it at cold start. Idempotent and cheap after the first call.
 */
export function initBitboard(): void {
  if (built) return;
  built = true;
  const r = [0, 0, 0, 0];
  for (let v = 0; v < 65536; v++) {
    r[0] = v & 0xf;
    r[1] = (v >> 4) & 0xf;
    r[2] = (v >> 8) & 0xf;
    r[3] = (v >> 12) & 0xf;
    const tiles = r.filter((x) => x !== 0);
    const out: number[] = [];
    for (let i = 0; i < tiles.length; i++) {
      if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
        out.push(Math.min(tiles[i] + 1, 15));
        i++;
      } else out.push(tiles[i]);
    }
    while (out.length < 4) out.push(0);
    const res = out[0] | (out[1] << 4) | (out[2] << 8) | (out[3] << 12);
    LINE_TOWARD_LOW[v] = res;
    SPREAD_LO[v] = (r[0] | (r[1] << 16)) >>> 0;
    SPREAD_HI[v] = (r[2] | (r[3] << 16)) >>> 0;
  }
  for (let v = 0; v < 65536; v++) {
    LINE_TOWARD_HIGH[v] = reverseLine(LINE_TOWARD_LOW[reverseLine(v)]);
  }
}

/** Output registers for functions producing a board (avoids allocation in the hot path). */
export let outLo = 0;
export let outHi = 0;

export function column(lo: number, hi: number, c: number): number {
  const s = 4 * c;
  return (
    ((lo >>> s) & 0xf) |
    (((lo >>> (16 + s)) & 0xf) << 4) |
    (((hi >>> s) & 0xf) << 8) |
    (((hi >>> (16 + s)) & 0xf) << 12)
  );
}

/** Apply a move; result in (outLo, outHi). Returns true if the board changed. */
export function bbMove(lo: number, hi: number, dir: number): boolean {
  let nlo: number;
  let nhi: number;
  if (dir === 2 || dir === 3) {
    const t = dir === 2 ? LINE_TOWARD_LOW : LINE_TOWARD_HIGH;
    nlo = (t[lo & 0xffff] | (t[lo >>> 16] << 16)) >>> 0;
    nhi = (t[hi & 0xffff] | (t[hi >>> 16] << 16)) >>> 0;
  } else {
    const t = dir === 0 ? LINE_TOWARD_LOW : LINE_TOWARD_HIGH;
    nlo = 0;
    nhi = 0;
    for (let c = 0; c < 4; c++) {
      const res = t[column(lo, hi, c)];
      nlo |= SPREAD_LO[res] << (4 * c);
      nhi |= SPREAD_HI[res] << (4 * c);
    }
    nlo >>>= 0;
    nhi >>>= 0;
  }
  outLo = nlo;
  outHi = nhi;
  return nlo !== lo || nhi !== hi;
}

export function nibble(lo: number, hi: number, i: number): number {
  return i < 8 ? (lo >>> (4 * i)) & 0xf : (hi >>> (4 * (i - 8))) & 0xf;
}

export function fromBoard(board: Board): [number, number] {
  initBitboard();
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 16; i++) {
    const e = Math.min(board[i], 15);
    if (i < 8) lo |= e << (4 * i);
    else hi |= e << (4 * (i - 8));
  }
  return [lo >>> 0, hi >>> 0];
}

export function toBoard(lo: number, hi: number): Board {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = nibble(lo, hi, i);
  return b;
}

export function distinctRanks(lo: number, hi: number): number {
  let mask = 0;
  for (let i = 0; i < 8; i++) {
    mask |= 1 << ((lo >>> (4 * i)) & 0xf);
    mask |= 1 << ((hi >>> (4 * i)) & 0xf);
  }
  mask &= ~1;
  let n = 0;
  while (mask) {
    mask &= mask - 1;
    n++;
  }
  return n;
}
