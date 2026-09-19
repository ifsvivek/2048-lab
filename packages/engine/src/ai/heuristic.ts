/** AI.md §2 — line-decomposable heuristic with integer weights. */
import { column, nibble } from './bitboard.ts';

export interface HeuristicWeights {
  lost: number;
  empty: number;
  merges: number;
  mono: number;
  sum: number;
  smooth: number;
  stable: number;
  corner: number;
}

export const HEURISTIC_V1: Readonly<HeuristicWeights> = Object.freeze({
  lost: 200000,
  empty: 270,
  merges: 700,
  mono: 47,
  sum: 11,
  smooth: 0,
  stable: 0,
  corner: 0,
});

export interface LineFeatures {
  empty: number;
  merges: number;
  mono: number;
  sum: number;
  smooth: number;
  stable: number;
}

export function lineFeatures(v: number): LineFeatures {
  const r = [v & 0xf, (v >> 4) & 0xf, (v >> 8) & 0xf, (v >> 12) & 0xf];
  let empty = 0;
  let merges = 0;
  let prev = 0;
  let counter = 0;
  let sum = 0;
  for (const rank of r) {
    sum += rank * rank * rank;
    if (rank === 0) {
      empty++;
      continue;
    }
    if (prev === rank) counter++;
    else if (counter > 0) {
      merges += 1 + counter;
      counter = 0;
    }
    prev = rank;
  }
  if (counter > 0) merges += 1 + counter;

  let monoL = 0;
  let monoR = 0;
  let smooth = 0;
  for (let i = 1; i < 4; i++) {
    const a = r[i - 1] ** 4;
    const b = r[i] ** 4;
    if (r[i - 1] > r[i]) monoL += a - b;
    else monoR += b - a;
    if (r[i - 1] !== 0 && r[i] !== 0) smooth += Math.abs(r[i - 1] - r[i]);
  }
  const stable = empty === 0 && (monoL === 0 || monoR === 0) ? 1 : 0;
  return { empty, merges, mono: Math.min(monoL, monoR), sum, smooth, stable };
}

export function lineScore(f: LineFeatures, w: HeuristicWeights): number {
  return (
    w.lost +
    w.empty * f.empty +
    w.merges * f.merges -
    w.mono * f.mono -
    w.sum * f.sum -
    w.smooth * f.smooth +
    w.stable * f.stable
  );
}

export function validateWeights(w: HeuristicWeights): void {
  for (const [k, v] of Object.entries(w)) {
    if (!Number.isInteger(v)) throw new Error(`heuristic weight '${k}' must be an integer (got ${v})`);
  }
}

const tableCache = new Map<string, Float64Array>();

/** 65536-entry per-line score table for the given weights (memoised). */
export function lineTable(w: HeuristicWeights): Float64Array {
  const key = JSON.stringify([w.lost, w.empty, w.merges, w.mono, w.sum, w.smooth, w.stable, w.corner]);
  let t = tableCache.get(key);
  if (!t) {
    validateWeights(w);
    t = new Float64Array(65536);
    for (let v = 0; v < 65536; v++) t[v] = lineScore(lineFeatures(v), w);
    tableCache.set(key, t);
  }
  return t;
}

export function cornerTerm(lo: number, hi: number, cornerWeight: number): number {
  if (cornerWeight === 0) return 0;
  let max = 0;
  for (let i = 0; i < 16; i++) {
    const n = nibble(lo, hi, i);
    if (n > max) max = n;
  }
  const c0 = lo & 0xf;
  const c3 = (lo >>> 12) & 0xf;
  const c12 = (hi >>> 16) & 0xf;
  const c15 = hi >>> 28;
  return c0 === max || c3 === max || c12 === max || c15 === max ? cornerWeight * max : 0;
}

export function evaluate(lo: number, hi: number, table: Float64Array, cornerWeight: number): number {
  return (
    table[lo & 0xffff] +
    table[lo >>> 16] +
    table[hi & 0xffff] +
    table[hi >>> 16] +
    table[column(lo, hi, 0)] +
    table[column(lo, hi, 1)] +
    table[column(lo, hi, 2)] +
    table[column(lo, hi, 3)] +
    cornerTerm(lo, hi, cornerWeight)
  );
}

export interface HeuristicBreakdown extends LineFeatures {
  corner: number;
  total: number;
}

/** Human-readable decomposition of the evaluation, summed over all 8 lines. */
export function breakdown(lo: number, hi: number, w: HeuristicWeights): HeuristicBreakdown {
  const lines = [lo & 0xffff, lo >>> 16, hi & 0xffff, hi >>> 16, column(lo, hi, 0), column(lo, hi, 1), column(lo, hi, 2), column(lo, hi, 3)];
  const acc: LineFeatures = { empty: 0, merges: 0, mono: 0, sum: 0, smooth: 0, stable: 0 };
  for (const v of lines) {
    const f = lineFeatures(v);
    for (const k of Object.keys(acc) as (keyof LineFeatures)[]) acc[k] += f[k];
  }
  const corner = cornerTerm(lo, hi, w.corner);
  return { ...acc, corner, total: evaluate(lo, hi, lineTable(w), w.corner) };
}
