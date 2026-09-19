/**
 * Game simulation and the benchmark-suite runner. The suite/result shapes are
 * defined by spec/schemas/benchmark-suite.schema.json and
 * spec/schemas/benchmark-result.schema.json and are shared by every language.
 */
import { maxExponent } from './board.ts';
import { Game, SPEC_VERSION } from './game.ts';
import { fnv1a32, hashHex } from './hash.ts';
import { type Agent, type BuiltinAgentId, createBuiltinAgent } from './ai/agents.ts';

export interface BenchmarkSuite {
  id: string;
  name: string;
  description?: string;
  specVersion: number;
  agent: { id: BuiltinAgentId; config?: Record<string, unknown> };
  seeds: { start: number; count: number };
  /** stop a game after this many moves (0 = play to completion) */
  maxMoves: number;
  /** record per-decision latency (disable for pure engine-throughput suites) */
  timeDecisions: boolean;
  tags?: string[];
}

export interface GameResult {
  seed: number;
  score: number;
  maxTile: number;
  moveCount: number;
  over: boolean;
  historyHash: string;
  wallMs: number;
  nodes: number;
}

export const REACH_TILES = [2048, 4096, 8192, 16384, 32768, 65536] as const;

export interface BenchmarkSummary {
  games: number;
  avgScore: number;
  medianScore: number;
  minScore: number;
  maxScore: number;
  maxTile: number;
  totalMoves: number;
  wallMs: number;
  cpuMs: number | null;
  gamesPerSec: number;
  movesPerSec: number;
  decisionsPerSec: number;
  nodes: number;
  nodesPerSec: number;
  peakMemoryBytes: number | null;
  avgDecisionUs: number | null;
  p50DecisionUs: number | null;
  p99DecisionUs: number | null;
  /** count of games whose max tile is exactly this value */
  tileDistribution: Record<string, number>;
  /** fraction of games reaching at least this tile */
  reachRates: Record<string, number>;
}

export interface Implementation {
  language: string;
  runtime: string;
  runtimeVersion: string;
  engineVersion: string;
  platform: string;
}

export interface BenchmarkResult {
  schemaVersion: 1;
  suiteId: string;
  specVersion: number;
  implementation: Implementation;
  environment: Record<string, string | number>;
  agent: { id: string; config?: Record<string, unknown> };
  deterministic: boolean;
  startedAt: string;
  finishedAt: string;
  games: GameResult[];
  summary: BenchmarkSummary;
  /** fnv1a32 over the concatenated historyHash strings — equal across languages for deterministic suites */
  checksum: string;
}

export interface PlayOptions {
  maxMoves?: number;
  gameId?: string;
  onDecision?: (timeUs: number, nodes: number) => void;
}

const clock: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

/** Play a synchronous agent to completion. */
export function playSync(agent: Agent, seed: number, opts: PlayOptions = {}): { game: Game; nodes: number; wallMs: number } {
  const t0 = clock();
  const game = new Game(seed);
  const meta = { seed: game.seed, specVersion: SPEC_VERSION, gameId: opts.gameId };
  agent.reset?.(meta);
  let nodes = 0;
  const limit = opts.maxMoves && opts.maxMoves > 0 ? opts.maxMoves : Infinity;
  while (game.moveCount < limit && !game.over) {
    const d = agent.decide({ board: game.board, score: game.score, moveCount: game.moveCount, meta });
    if (d instanceof Promise) throw new Error('playSync requires a synchronous agent');
    if (!game.apply(d.move)) throw new Error(`agent ${agent.descriptor.id} returned invalid move ${d.move} at ${game.moveCount}`);
    nodes += d.metrics.nodes ?? 0;
    opts.onDecision?.(d.metrics.timeUs, d.metrics.nodes ?? 0);
  }
  return { game, nodes, wallMs: clock() - t0 };
}

export interface SuiteHooks {
  implementation: Implementation;
  environment: Record<string, string | number>;
  /** returns current resident memory in bytes, if the platform can measure it */
  memory?: () => number | null;
  /** returns cumulative process CPU time in ms, if measurable */
  cpuMs?: () => number | null;
  onGame?: (r: GameResult, index: number) => void;
  /** yield to the event loop between games (browsers) */
  yieldBetweenGames?: () => Promise<void>;
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function summarise(games: GameResult[], wallMs: number, cpuMs: number | null, peakMemoryBytes: number | null, decisions: Float64Array | null): BenchmarkSummary {
  const scores = games.map((g) => g.score).sort((a, b) => a - b);
  const totalMoves = games.reduce((a, g) => a + g.moveCount, 0);
  const nodes = games.reduce((a, g) => a + g.nodes, 0);
  const tileDistribution: Record<string, number> = {};
  for (const g of games) tileDistribution[g.maxTile] = (tileDistribution[g.maxTile] ?? 0) + 1;
  const reachRates: Record<string, number> = {};
  for (const t of REACH_TILES) reachRates[t] = games.length ? games.filter((g) => g.maxTile >= t).length / games.length : 0;
  const secs = wallMs / 1000;
  let avgDecisionUs: number | null = null;
  let p50: number | null = null;
  let p99: number | null = null;
  if (decisions && decisions.length) {
    const sorted = decisions.slice().sort();
    let s = 0;
    for (const x of sorted) s += x;
    avgDecisionUs = s / sorted.length;
    p50 = percentile(sorted, 0.5);
    p99 = percentile(sorted, 0.99);
  }
  return {
    games: games.length,
    avgScore: games.length ? scores.reduce((a, b) => a + b, 0) / games.length : 0,
    medianScore: scores.length ? scores[Math.floor(scores.length / 2)] : 0,
    minScore: scores[0] ?? 0,
    maxScore: scores[scores.length - 1] ?? 0,
    maxTile: games.reduce((a, g) => Math.max(a, g.maxTile), 0),
    totalMoves,
    wallMs,
    cpuMs,
    gamesPerSec: secs > 0 ? games.length / secs : 0,
    movesPerSec: secs > 0 ? totalMoves / secs : 0,
    decisionsPerSec: secs > 0 ? totalMoves / secs : 0,
    nodes,
    nodesPerSec: secs > 0 ? nodes / secs : 0,
    peakMemoryBytes,
    avgDecisionUs,
    p50DecisionUs: p50,
    p99DecisionUs: p99,
    tileDistribution,
    reachRates,
  };
}

export function suiteChecksum(games: GameResult[]): string {
  const bytes: number[] = [];
  for (const g of games) for (let i = 0; i < g.historyHash.length; i++) bytes.push(g.historyHash.charCodeAt(i));
  return hashHex(fnv1a32(bytes));
}

export async function runSuite(suite: BenchmarkSuite, hooks: SuiteHooks): Promise<BenchmarkResult> {
  if (suite.specVersion !== SPEC_VERSION) throw new Error(`suite ${suite.id} targets spec v${suite.specVersion}`);
  const agent = createBuiltinAgent(suite.agent.id, suite.agent.config);
  const startedAt = new Date().toISOString();
  const cpu0 = hooks.cpuMs?.() ?? null;
  let peak = hooks.memory?.() ?? null;
  const t0 = clock();
  let decisions: Float64Array | null = suite.timeDecisions ? new Float64Array(1024) : null;
  let nd = 0;
  const onDecision = suite.timeDecisions
    ? (us: number) => {
        if (nd === decisions!.length) {
          const grown = new Float64Array(decisions!.length * 2);
          grown.set(decisions!);
          decisions = grown;
        }
        decisions![nd++] = us;
      }
    : undefined;

  const games: GameResult[] = [];
  for (let i = 0; i < suite.seeds.count; i++) {
    const seed = (suite.seeds.start + i) >>> 0;
    const { game, nodes, wallMs } = playSync(agent, seed, { maxMoves: suite.maxMoves, onDecision });
    const r: GameResult = {
      seed,
      score: game.score,
      maxTile: 2 ** maxExponent(game.board),
      moveCount: game.moveCount,
      over: game.over,
      historyHash: game.historyHash,
      wallMs,
      nodes,
    };
    games.push(r);
    const m = hooks.memory?.() ?? null;
    if (m !== null && (peak === null || m > peak)) peak = m;
    hooks.onGame?.(r, i);
    if (hooks.yieldBetweenGames) await hooks.yieldBetweenGames();
  }
  const wallMs = clock() - t0;
  const cpu1 = hooks.cpuMs?.() ?? null;
  const agentConfig = agent.descriptor.config;
  const deterministic = !(agentConfig && typeof agentConfig.timeBudgetMs === 'number' && agentConfig.timeBudgetMs > 0);
  return {
    schemaVersion: 1,
    suiteId: suite.id,
    specVersion: SPEC_VERSION,
    implementation: hooks.implementation,
    environment: hooks.environment,
    agent: { id: suite.agent.id, config: suite.agent.config },
    deterministic,
    startedAt,
    finishedAt: new Date().toISOString(),
    games,
    summary: summarise(games, wallMs, cpu0 !== null && cpu1 !== null ? cpu1 - cpu0 : null, peak, decisions ? decisions.subarray(0, nd) : null),
    checksum: suiteChecksum(games),
  };
}
