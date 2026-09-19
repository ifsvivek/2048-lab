/** AI.md §3 — canonical expectimax search with an exact transposition table. */
import * as bb from './bitboard.ts';
import { bbMove, column, distinctRanks, initBitboard, nibble } from './bitboard.ts';
import { type HeuristicBreakdown, type HeuristicWeights, HEURISTIC_V1, breakdown, cornerTerm, lineTable } from './heuristic.ts';

export interface ExpectimaxConfig {
  depth: number | 'auto';
  minDepth: number;
  maxDepth: number;
  /** skip 4-spawns at chance nodes with at least this many empty cells (0 = never) */
  fourPruneEmpties: number;
  /** >0 enables iterative deepening under a wall-clock budget (non-deterministic) */
  timeBudgetMs: number;
  /** log2 of transposition table slots */
  ttBits: number;
  weights: HeuristicWeights;
}

export const CANONICAL_EXPECTIMAX: Readonly<ExpectimaxConfig> = Object.freeze({
  depth: 'auto',
  minDepth: 2,
  maxDepth: 4,
  fourPruneEmpties: 0,
  timeBudgetMs: 0,
  ttBits: 20,
  weights: HEURISTIC_V1,
});

export interface SearchResult {
  move: number | null;
  value: number;
  /** root value per direction; null for invalid moves */
  values: (number | null)[];
  depth: number;
  nodes: number;
  ttHits: number;
  ttSize: number;
  timeUs: number;
  deterministic: boolean;
  completedDepths: number[];
}

class Timeout extends Error {}

const now: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

/**
 * Exact-key transposition table: (lo, hi, depth) -> value. Because chance()
 * is a pure function of (board, depth) the table never changes results.
 */
class TranspositionTable {
  readonly mask: number;
  readonly lo: Uint32Array;
  readonly hi: Uint32Array;
  readonly depth: Uint8Array;
  readonly value: Float64Array;
  size = 0;

  constructor(bits: number) {
    const n = 1 << bits;
    this.mask = n - 1;
    this.lo = new Uint32Array(n);
    this.hi = new Uint32Array(n);
    this.depth = new Uint8Array(n);
    this.value = new Float64Array(n);
  }

  slot(lo: number, hi: number, d: number): number {
    let h = Math.imul(lo ^ Math.imul(d, 0x9e3779b1), 0x85ebca6b) ^ Math.imul(hi, 0xc2b2ae35);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return h & this.mask;
  }

  clear(): void {
    this.depth.fill(0);
    this.size = 0;
  }
}

export class ExpectimaxSearch {
  readonly config: ExpectimaxConfig;
  private readonly table: Float64Array;
  private readonly corner: number;
  private readonly tt: TranspositionTable;
  private nodes = 0;
  private ttHits = 0;
  private deadline = Infinity;

  constructor(config: Partial<ExpectimaxConfig> = {}) {
    initBitboard();
    this.config = { ...CANONICAL_EXPECTIMAX, ...config, weights: { ...HEURISTIC_V1, ...config.weights } };
    this.table = lineTable(this.config.weights);
    this.corner = this.config.weights.corner;
    this.tt = new TranspositionTable(this.config.ttBits);
  }

  evaluate(lo: number, hi: number): number {
    const t = this.table;
    return (
      t[lo & 0xffff] +
      t[lo >>> 16] +
      t[hi & 0xffff] +
      t[hi >>> 16] +
      t[column(lo, hi, 0)] +
      t[column(lo, hi, 1)] +
      t[column(lo, hi, 2)] +
      t[column(lo, hi, 3)] +
      (this.corner === 0 ? 0 : cornerTerm(lo, hi, this.corner))
    );
  }

  breakdown(lo: number, hi: number): HeuristicBreakdown {
    return breakdown(lo, hi, this.config.weights);
  }

  depthFor(lo: number, hi: number): number {
    const c = this.config;
    if (c.depth !== 'auto') return c.depth;
    return Math.max(c.minDepth, Math.min(c.maxDepth, distinctRanks(lo, hi) - 2));
  }

  private maxnode(lo: number, hi: number, d: number): number {
    this.nodes++;
    if (d === 0) return this.evaluate(lo, hi);
    let best = 0;
    for (let dir = 0; dir < 4; dir++) {
      if (!bbMove(lo, hi, dir)) continue;
      const v = this.chance(bb.outLo, bb.outHi, d);
      if (v > best) best = v;
    }
    return best;
  }

  private chance(lo: number, hi: number, d: number): number {
    this.nodes++;
    if ((this.nodes & 0xfff) === 0 && now() > this.deadline) throw new Timeout();
    const tt = this.tt;
    const slot = tt.slot(lo, hi, d);
    let s = slot;
    for (let probe = 0; probe < 4; probe++) {
      const sd = tt.depth[s];
      if (sd === 0) break;
      if (sd === d && tt.lo[s] === lo && tt.hi[s] === hi) {
        this.ttHits++;
        return tt.value[s];
      }
      s = (s + 1) & tt.mask;
    }

    let n = 0;
    for (let i = 0; i < 16; i++) if (nibble(lo, hi, i) === 0) n++;
    const four = !(this.config.fourPruneEmpties > 0 && n >= this.config.fourPruneEmpties);
    let sum = 0;
    for (let i = 0; i < 16; i++) {
      if (nibble(lo, hi, i) !== 0) continue;
      let lo2 = lo;
      let hi2 = hi;
      let lo4 = lo;
      let hi4 = hi;
      if (i < 8) {
        lo2 = (lo | (1 << (4 * i))) >>> 0;
        lo4 = (lo | (2 << (4 * i))) >>> 0;
      } else {
        hi2 = (hi | (1 << (4 * (i - 8)))) >>> 0;
        hi4 = (hi | (2 << (4 * (i - 8)))) >>> 0;
      }
      if (four) {
        sum = sum + 0.9 * this.maxnode(lo2, hi2, d - 1);
        sum = sum + 0.1 * this.maxnode(lo4, hi4, d - 1);
      } else {
        sum = sum + this.maxnode(lo2, hi2, d - 1);
      }
    }
    const v = sum / n;

    // Store: first empty slot in the probe window, else overwrite the home slot.
    let target = slot;
    s = slot;
    for (let probe = 0; probe < 4; probe++) {
      if (tt.depth[s] === 0) {
        target = s;
        tt.size++;
        break;
      }
      s = (s + 1) & tt.mask;
    }
    tt.lo[target] = lo;
    tt.hi[target] = hi;
    tt.depth[target] = d;
    tt.value[target] = v;
    return v;
  }

  private root(lo: number, hi: number, depth: number): { move: number | null; value: number; values: (number | null)[] } {
    let move: number | null = null;
    let value = -Infinity;
    const values: (number | null)[] = [null, null, null, null];
    for (let dir = 0; dir < 4; dir++) {
      if (!bbMove(lo, hi, dir)) continue;
      const v = this.chance(bb.outLo, bb.outHi, depth);
      values[dir] = v;
      if (v > value) {
        value = v;
        move = dir;
      }
    }
    return { move, value, values };
  }

  search(lo: number, hi: number): SearchResult {
    const start = now();
    this.nodes = 0;
    this.ttHits = 0;
    const budget = this.config.timeBudgetMs;
    if (this.tt.size > (this.tt.mask + 1) * 0.75) this.tt.clear();

    if (budget <= 0) {
      this.deadline = Infinity;
      const depth = this.depthFor(lo, hi);
      const r = this.root(lo, hi, depth);
      return this.result(r, depth, start, true, [depth]);
    }

    // Iterative deepening: keep the deepest completed iteration.
    this.deadline = Infinity; // depth 1 always completes
    let best = this.root(lo, hi, 1);
    this.deadline = start + budget;
    let depth = 1;
    const completed = [1];
    for (let d = 2; d <= this.config.maxDepth; d++) {
      try {
        best = this.root(lo, hi, d);
        depth = d;
        completed.push(d);
      } catch (e) {
        if (!(e instanceof Timeout)) throw e;
        break;
      }
    }
    this.deadline = Infinity;
    return this.result(best, depth, start, false, completed);
  }

  private result(
    r: { move: number | null; value: number; values: (number | null)[] },
    depth: number,
    start: number,
    deterministic: boolean,
    completedDepths: number[],
  ): SearchResult {
    return {
      ...r,
      depth,
      nodes: this.nodes,
      ttHits: this.ttHits,
      ttSize: this.tt.size,
      timeUs: Math.round((now() - start) * 1000),
      deterministic,
      completedDepths,
    };
  }
}
