/**
 * The common agent interface. Every agent — built-in, remote (HTTP), worker,
 * Python/Rust/Go runner or LLM-backed — is driven through this contract, and
 * the HTTP agent protocol (spec/openapi.yaml, `AgentRequest`/`AgentResponse`)
 * is a direct serialisation of it.
 */
import { type Board, type Direction, DIRECTION_NAMES, boardToHex, boardToMatrix, validMoves } from '../board.ts';
import { Rng } from '../rng.ts';
import { fromBoard, bbMove, outLo, outHi } from './bitboard.ts';
import { type ExpectimaxConfig, ExpectimaxSearch, type SearchResult } from './expectimax.ts';
import type { HeuristicBreakdown } from './heuristic.ts';

export interface GameMeta {
  gameId?: string;
  seed: number;
  specVersion: number;
}

export interface Observation {
  /** exponents, row-major (the canonical representation) */
  board: Board;
  score: number;
  moveCount: number;
  meta: GameMeta;
}

export interface DecisionMetrics {
  depth?: number;
  nodes?: number;
  ttHits?: number;
  ttSize?: number;
  timeUs: number;
  values?: (number | null)[];
  heuristic?: HeuristicBreakdown;
  deterministic?: boolean;
  completedDepths?: number[];
  note?: string;
}

export interface Decision {
  move: Direction;
  metrics: DecisionMetrics;
}

export type AgentKind = 'builtin' | 'remote' | 'worker' | 'llm' | 'human';

export interface AgentDescriptor {
  id: string;
  name: string;
  version: string;
  kind: AgentKind;
  language: string;
  config?: Record<string, unknown>;
}

export interface Agent {
  readonly descriptor: AgentDescriptor;
  /** Called once per game before the first decision. */
  reset?(meta: GameMeta): void;
  /** Return a valid move. Only called when at least one move is valid. */
  decide(obs: Observation): Decision | Promise<Decision>;
}

const clock: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

/** SPEC §10 reference random agent. */
export class RandomAgent implements Agent {
  readonly descriptor: AgentDescriptor = { id: 'builtin/random', name: 'Random', version: '1.0.0', kind: 'builtin', language: 'typescript' };
  private rng = Rng.fromSeed(0);

  reset(meta: GameMeta): void {
    this.rng = Rng.fromSeed((meta.seed ^ 0xa5a5a5a5) >>> 0);
  }

  decide(obs: Observation): Decision {
    const t = clock();
    const valid = validMoves(obs.board);
    const move = valid[this.rng.below(valid.length)];
    return { move, metrics: { timeUs: Math.round((clock() - t) * 1000), deterministic: true } };
  }
}

/** One-ply greedy: maximise empty cells after the move, ties to the lower direction. */
export class GreedyAgent implements Agent {
  readonly descriptor: AgentDescriptor = { id: 'builtin/greedy', name: 'Greedy', version: '1.0.0', kind: 'builtin', language: 'typescript' };

  decide(obs: Observation): Decision {
    const t = clock();
    const [lo, hi] = fromBoard(obs.board);
    let best: Direction = validMoves(obs.board)[0];
    let bestScore = -1;
    for (let d = 0; d < 4; d++) {
      if (!bbMove(lo, hi, d)) continue;
      let empty = 0;
      for (let i = 0; i < 8; i++) {
        if (((outLo >>> (4 * i)) & 0xf) === 0) empty++;
        if (((outHi >>> (4 * i)) & 0xf) === 0) empty++;
      }
      if (empty > bestScore) {
        bestScore = empty;
        best = d as Direction;
      }
    }
    return { move: best, metrics: { timeUs: Math.round((clock() - t) * 1000), deterministic: true } };
  }
}

export class ExpectimaxAgent implements Agent {
  readonly descriptor: AgentDescriptor;
  readonly search: ExpectimaxSearch;
  lastResult: SearchResult | null = null;

  constructor(config: Partial<ExpectimaxConfig> = {}, name = 'Expectimax') {
    this.search = new ExpectimaxSearch(config);
    this.descriptor = {
      id: 'builtin/expectimax',
      name,
      version: '1.0.0',
      kind: 'builtin',
      language: 'typescript',
      config: { ...this.search.config },
    };
  }

  decide(obs: Observation): Decision {
    const [lo, hi] = fromBoard(obs.board);
    const r = this.search.search(lo, hi);
    this.lastResult = r;
    const move = (r.move ?? validMoves(obs.board)[0]) as Direction;
    return {
      move,
      metrics: {
        depth: r.depth,
        nodes: r.nodes,
        ttHits: r.ttHits,
        ttSize: r.ttSize,
        timeUs: r.timeUs,
        values: r.values,
        heuristic: this.search.breakdown(lo, hi),
        deterministic: r.deterministic,
        completedDepths: r.completedDepths,
      },
    };
  }
}

export type BuiltinAgentId = 'random' | 'greedy' | 'expectimax';

export function createBuiltinAgent(id: BuiltinAgentId, config: Record<string, unknown> = {}): Agent {
  switch (id) {
    case 'random':
      return new RandomAgent();
    case 'greedy':
      return new GreedyAgent();
    case 'expectimax':
      return new ExpectimaxAgent(config as Partial<ExpectimaxConfig>);
  }
}

/** Wire format sent to remote agents (see spec/openapi.yaml AgentRequest). */
export interface AgentRequest {
  gameId?: string;
  seed: number;
  specVersion: number;
  board: number[][];
  boardHex: string;
  score: number;
  moveCount: number;
  validMoves: string[];
}

export function toAgentRequest(obs: Observation): AgentRequest {
  return {
    gameId: obs.meta.gameId,
    seed: obs.meta.seed,
    specVersion: obs.meta.specVersion,
    board: boardToMatrix(obs.board),
    boardHex: boardToHex(obs.board),
    score: obs.score,
    moveCount: obs.moveCount,
    validMoves: validMoves(obs.board).map((d) => DIRECTION_NAMES[d]),
  };
}
