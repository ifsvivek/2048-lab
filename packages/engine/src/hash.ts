/** SPEC §7 — FNV-1a 32-bit board and history hashes. */
import type { Board } from './board.ts';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(bytes: ArrayLike<number>, h = FNV_OFFSET): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ (bytes[i] & 0xff), FNV_PRIME) >>> 0;
  return h >>> 0;
}

export function boardHash(board: Board): number {
  return fnv1a32(board);
}

/** h' = fnv1a32(le32(h) ++ board ++ [dir]) */
export function historyStep(h: number, board: Board, dir: number): number {
  let x = FNV_OFFSET;
  for (let k = 0; k < 4; k++) x = Math.imul(x ^ ((h >>> (8 * k)) & 0xff), FNV_PRIME) >>> 0;
  for (let i = 0; i < 16; i++) x = Math.imul(x ^ board[i], FNV_PRIME) >>> 0;
  x = Math.imul(x ^ dir, FNV_PRIME) >>> 0;
  return x;
}

export const hashHex = (h: number): string => (h >>> 0).toString(16).padStart(8, '0');
