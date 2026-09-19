/**
 * Validates the TypeScript engine against spec/fixtures — the same checks
 * every other language runs. Used by vitest and by `ts-cli.ts validate`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Direction,
  Game,
  Rng,
  ReplayError,
  boardFromHex,
  boardHash,
  boardToHex,
  formatReplayCode,
  hashHex,
  historyStep,
  isOver,
  mix32,
  move,
  normalizeReplayCode,
  simulate,
  spawn,
  verifyReplay,
} from '../src/index.ts';
import * as bb from '../src/ai/bitboard.ts';
import { ExpectimaxAgent, ExpectimaxSearch, HEURISTIC_V1, RandomAgent, bbMove, fromBoard, lineFeatures, lineTable, toBoard } from '../src/ai/index.ts';
import { type BenchmarkSuite, playSync, runSuite } from '../src/sim.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'fixtures');
const SPEC = join(FIXTURES, '..');

const load = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

export interface CheckReport {
  passed: number;
  failed: number;
  failures: { fixture: string; case: string; message: string }[];
}

export async function runFixtureChecks(opts: { benchmarks?: boolean } = {}): Promise<CheckReport> {
  const rep: CheckReport = { passed: 0, failed: 0, failures: [] };
  const check = (fixture: string, name: string, ok: boolean, message = 'mismatch') => {
    if (ok) rep.passed++;
    else {
      rep.failed++;
      rep.failures.push({ fixture, case: name, message });
    }
  };

  for (const c of load('rng.json').cases) {
    check('rng.json', `mix32(${c.seed})`, eq(mix32(c.seed), c.state));
    const r = new Rng(c.state);
    check('rng.json', `next(${c.seed})`, eq(c.next.map(() => r.next()), c.next));
    for (const [n, vals] of Object.entries(c.below) as [string, number[]][]) {
      const rb = Rng.fromSeed(c.seed);
      check('rng.json', `below(${c.seed},${n})`, eq(vals.map(() => rb.below(Number(n))), vals));
    }
  }

  for (const c of load('moves.json').cases) {
    const b = boardFromHex(c.board);
    for (const r of c.results) {
      const m = move(b, 'UDLR'.indexOf(r.dir) as Direction);
      check('moves.json', `${c.board}/${r.dir}`, boardToHex(m.board) === r.board && m.gained === r.gained && m.changed === r.changed);
    }
    check('moves.json', `${c.board}/over`, isOver(b) === c.over);
  }

  for (const c of load('spawn.json').cases) {
    const b = boardFromHex(c.board);
    const rng = new Rng(c.rngState);
    const s = spawn(b, rng);
    check('spawn.json', c.board, boardToHex(b) === c.result && eq(rng.state(), c.rngStateAfter) && eq(s, c.spawn));
  }

  for (const c of load('hash.json').cases) {
    const b = boardFromHex(c.board);
    check('hash.json', c.board, hashHex(boardHash(b)) === c.boardHash && hashHex(historyStep(parseInt(c.prev, 16), b, c.dir)) === c.historyStep);
  }

  const games = load('games.json');
  for (const c of games.newGames) {
    const g = new Game(c.seed);
    check('games.json', `new(${c.seed})`, boardToHex(g.board) === c.board && eq(g.rngState(), c.rngState) && g.historyHash === c.historyHash);
  }
  for (const c of games.games) {
    const snap = simulate(c.seed, c.moves).snapshot();
    const { seed: _s, ...rest } = snap;
    check('games.json', `replay(${c.agent},${c.seed})`, eq(rest, c.final));
    const agent = c.agent === 'random' ? new RandomAgent() : new ExpectimaxAgent({ depth: 2 });
    const { game } = playSync(agent, c.seed, { maxMoves: c.maxMoves });
    check('games.json', `agent(${c.agent},${c.seed})`, game.moves === c.moves);
  }

  for (const c of load('replays.json').cases) {
    try {
      const snap = verifyReplay({ specVersion: 1, seed: c.seed, moves: c.moves });
      const { seed: _s, ...rest } = snap;
      check('replays.json', c.name, c.expect.ok && eq(rest, c.expect.final));
    } catch (e) {
      check('replays.json', c.name, !c.expect.ok && e instanceof ReplayError && e.code === c.expect.error && e.moveIndex === c.expect.moveIndex, String(e));
    }
  }

  for (const c of load('codes.json').cases) {
    const n = normalizeReplayCode(c.input);
    check('codes.json', c.input, n === c.normalized && (n ? formatReplayCode(n) : null) === c.formatted);
  }

  const ai = load('ai.json');
  const all = ai.weights.allWeights;
  for (const c of ai.lines) {
    check('ai.json', `line ${c.line}`, eq(lineFeatures(c.line), c.features) && lineTable(HEURISTIC_V1)[c.line] === c.canonical && lineTable(all)[c.line] === c.allWeights);
  }
  for (const c of ai.evaluations) {
    const [lo, hi] = fromBoard(boardFromHex(c.board));
    check('ai.json', `eval ${c.board}`, new ExpectimaxSearch().evaluate(lo, hi) === c.canonical && new ExpectimaxSearch({ weights: all }).evaluate(lo, hi) === c.allWeights);
  }
  for (const c of ai.bitboardMoves) {
    const [lo, hi] = fromBoard(boardFromHex(c.board));
    c.results.forEach((r: { changed: boolean; board: string }, d: number) => {
      const changed = bbMove(lo, hi, d);
      check('ai.json', `bb ${c.board}/${d}`, changed === r.changed && boardToHex(toBoard(bb.outLo, bb.outHi)) === r.board);
    });
  }
  for (const c of ai.searches) {
    const [lo, hi] = fromBoard(boardFromHex(c.board));
    const r = new ExpectimaxSearch(c.config).search(lo, hi);
    const mv = r.move === null ? null : 'UDLR'[r.move];
    check('ai.json', `search ${c.profile} ${c.board}`, mv === c.move && r.depth === c.depth && r.values.every((v, i) => close(v, c.values[i])));
  }

  if (opts.benchmarks !== false) {
    const expected = load('benchmarks.json').suites;
    for (const [id, e] of Object.entries(expected) as [string, any][]) {
      const suite = JSON.parse(readFileSync(join(SPEC, 'benchmarks', `${id}.json`), 'utf8')) as BenchmarkSuite;
      const r = await runSuite(suite, { implementation: { language: 'typescript', runtime: 'node', runtimeVersion: '', engineVersion: '', platform: '' }, environment: {} });
      check('benchmarks.json', id, r.checksum === e.checksum && r.summary.totalMoves === e.totalMoves && r.games.reduce((a, g) => a + g.score, 0) === e.totalScore && r.summary.maxScore === e.maxScore);
    }
  }
  return rep;
}
