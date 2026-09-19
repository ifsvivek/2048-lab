/**
 * Generates spec/fixtures/*.json from the TypeScript reference engine.
 *
 * The fixtures are the cross-language contract: every port loads them and
 * must reproduce every value. Regenerate only when the spec version changes
 * (CI fails if regenerated fixtures differ from the committed ones).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Board,
  type Direction,
  DIRECTION_LETTERS,
  Game,
  Rng,
  SPEC_VERSION,
  boardFromHex,
  boardHash,
  boardToHex,
  hashHex,
  historyStep,
  isOver,
  mix32,
  move,
  normalizeReplayCode,
  formatReplayCode,
  simulate,
  spawn,
  ReplayError,
} from '@g2048/engine';
import { ExpectimaxSearch, HEURISTIC_V1, fromBoard, lineFeatures, lineTable, type HeuristicWeights, bbMove, toBoard } from '@g2048/engine/ai';
import * as bb from '../../packages/engine/src/ai/bitboard.ts';
import { type BenchmarkSuite, playSync, runSuite } from '@g2048/engine/sim';
import { RandomAgent, ExpectimaxAgent } from '@g2048/engine/ai';
import { specDir } from './paths.ts';

const OUT = join(specDir, 'fixtures');
mkdirSync(OUT, { recursive: true });

function write(name: string, data: unknown): void {
  const body = { specVersion: SPEC_VERSION, generatedBy: 'typescript-reference', ...(data as object) };
  writeFileSync(join(OUT, name), JSON.stringify(body, null, 1) + '\n');
  console.log(`wrote fixtures/${name}`);
}

const gen = Rng.fromSeed(2048);

function randomBoard(density: number, maxExp: number): Board {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    if (gen.below(100) < density) b[i] = 1 + gen.below(maxExp);
  }
  return b;
}

// ---------------------------------------------------------------- rng.json
{
  const seeds = [0, 1, 2, 42, 2048, 123456789, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff];
  const cases = seeds.map((seed) => {
    const state = mix32(seed);
    const r = new Rng(state);
    const next = Array.from({ length: 16 }, () => r.next());
    const below: Record<string, number[]> = {};
    for (const n of [1, 2, 3, 7, 10, 13, 16, 1000, 4294967295]) {
      const rb = Rng.fromSeed(seed);
      below[n] = Array.from({ length: 12 }, () => rb.below(n));
    }
    return { seed, state, next, below };
  });
  write('rng.json', { description: 'SPEC §4: mix32 seed expansion, xoshiro128** outputs, below(n) sequences (each from a fresh generator).', cases });
}

// -------------------------------------------------------------- moves.json
{
  const boards: Board[] = [];
  const hand = [
    '0000000000000000',
    '1111000000000000',
    '1120000000000000',
    '2110000000000000',
    '1010101010101010',
    '1234432112344321',
    '1212212112122121',
    '0001001001001000',
    'bbbb000000000000',
    'ffff000000000000',
    'gg00000000000000', // 65536 + 65536
    'hggf000000000000',
    '2211221122112211',
    '1122334455667788',
  ];
  for (const h of hand) boards.push(boardFromHex(h));
  for (let k = 0; k < 120; k++) boards.push(randomBoard(20 + gen.below(80), k < 100 ? 11 : 17));
  const cases = boards.map((b) => ({
    board: boardToHex(b),
    results: [0, 1, 2, 3].map((d) => {
      const r = move(b, d as Direction);
      return { dir: DIRECTION_LETTERS[d], board: boardToHex(r.board), gained: r.gained, changed: r.changed };
    }),
    over: isOver(b),
  }));
  write('moves.json', { description: 'SPEC §3: line merge / moves in every direction. `changed=false` means the move is invalid.', cases });
}

// -------------------------------------------------------------- spawn.json
{
  const cases = [];
  for (let k = 0; k < 60; k++) {
    const b = k === 0 ? new Uint8Array(16) : k === 1 ? boardFromHex('123456789abcdef0') : k === 2 ? boardFromHex('123456789abcdef1') : randomBoard(10 + gen.below(85), 11);
    const state = Rng.fromSeed(gen.next()).state();
    const rng = new Rng(state);
    const after = b.slice();
    const s = spawn(after, rng);
    cases.push({ board: boardToHex(b), rngState: state, result: boardToHex(after), rngStateAfter: rng.state(), spawn: s });
  }
  write('spawn.json', { description: 'SPEC §5: spawn from an explicit generator state. spawn=null means the board was full (no draws).', cases });
}

// --------------------------------------------------------------- hash.json
{
  const cases = [];
  for (let k = 0; k < 20; k++) {
    const b = randomBoard(60, 12);
    const prev = gen.next();
    const dir = gen.below(4);
    cases.push({ board: boardToHex(b), boardHash: hashHex(boardHash(b)), prev: hashHex(prev), dir, historyStep: hashHex(historyStep(prev, b, dir)) });
  }
  write('hash.json', { description: 'SPEC §7: fnv1a32 board hash and history step.', cases });
}

// -------------------------------------------------------------- games.json
{
  const newGames = [0, 1, 7, 42, 99, 2048, 0xffffffff].map((seed) => {
    const g = new Game(seed);
    return { seed, board: boardToHex(g.board), rngState: g.rngState(), historyHash: g.historyHash };
  });
  const played = [];
  for (let seed = 1; seed <= 40; seed++) {
    const { game } = playSync(new RandomAgent(), seed);
    played.push({ seed, agent: 'random', moves: game.moves, final: omitSeed(game.snapshot()) });
  }
  for (const seed of [1, 2]) {
    const { game } = playSync(new ExpectimaxAgent({ depth: 2 }), seed, { maxMoves: 1500 });
    played.push({ seed, agent: 'expectimax-d2', maxMoves: 1500, moves: game.moves, final: omitSeed(game.snapshot()) });
  }
  write('games.json', {
    description: 'SPEC §6/§10: new-game states, and full games replayed from (seed, moves). Random-agent games also verify the SPEC §10 agent (replaying the agent must yield exactly `moves`).',
    newGames,
    games: played,
  });
}

function omitSeed<T extends { seed: number }>(s: T): Omit<T, 'seed'> {
  const { seed: _s, ...rest } = s;
  return rest;
}

// ------------------------------------------------------------ replays.json
{
  const good = new Game(77);
  const dirs: Direction[] = [2, 0, 3, 1];
  let k = 0;
  while (good.moveCount < 40 && !good.over) {
    if (!good.apply(dirs[k++ % 4])) good.apply(([0, 1, 2, 3] as Direction[]).find((d) => move(good.board, d).changed)!);
  }
  const moves = good.moves;
  // Find a position where some direction is invalid to create an INVALID_MOVE_AT case.
  const probe = simulate(5, '');
  const invalidDir = ([0, 1, 2, 3] as Direction[]).find((d) => !move(probe.board, d).changed);
  const cases: unknown[] = [
    { name: 'valid', seed: 77, moves, expect: { ok: true, final: omitSeed(good.snapshot()) } },
    { name: 'empty', seed: 12, moves: '', expect: { ok: true, final: omitSeed(new Game(12).snapshot()) } },
    { name: 'bad-letter', seed: 77, moves: moves.slice(0, 5) + 'X', expect: { ok: false, error: 'BAD_LETTER', moveIndex: 5 } },
  ];
  if (invalidDir !== undefined) {
    cases.push({ name: 'invalid-first-move', seed: 5, moves: DIRECTION_LETTERS[invalidDir], expect: { ok: false, error: 'INVALID_MOVE_AT', moveIndex: 0 } });
  }
  // Truncate a random game and append a direction that is invalid there.
  for (let seed = 100; seed < 400; seed++) {
    const { game } = playSync(new RandomAgent(), seed, { maxMoves: 30 });
    const bad = ([0, 1, 2, 3] as Direction[]).find((d) => !move(game.board, d).changed);
    if (bad !== undefined && !game.over) {
      cases.push({ name: 'invalid-mid-game', seed, moves: game.moves + DIRECTION_LETTERS[bad], expect: { ok: false, error: 'INVALID_MOVE_AT', moveIndex: game.moveCount } });
      break;
    }
  }
  for (const c of cases as { moves: string; seed: number; expect: { ok: boolean; error?: string } }[]) {
    try {
      simulate(c.seed, c.moves);
      if (!c.expect.ok) throw new Error('expected failure');
    } catch (e) {
      if (c.expect.ok || !(e instanceof ReplayError) || e.code !== c.expect.error) throw e;
    }
  }
  write('replays.json', { description: 'SPEC §6/§8: replay verification including error cases.', cases });
}

// --------------------------------------------------------------- codes.json
{
  const inputs = ['A7KF-29LM-XQ4P', 'a7kf29lmxq4p', ' a7kf 29lm xq4p ', 'A7KF-29LM-XQ4', 'A7KF-29LM-XQ4PP', 'A7KF-29LM-XQ40', 'I7KF-29LM-XQ4P', 'O7KF-29LM-XQ4P', 'A7KF_29LM_XQ4P'];
  const cases = inputs.map((input) => {
    const n = normalizeReplayCode(input);
    return { input, normalized: n, formatted: n ? formatReplayCode(n) : null };
  });
  write('codes.json', { description: 'SPEC §9: replay code normalisation.', alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', cases });
}

// ------------------------------------------------------------------ ai.json
{
  const ALL: HeuristicWeights = { lost: 200000, empty: 270, merges: 700, mono: 47, sum: 11, smooth: 30, stable: 500, corner: 1000 };
  const positions: Board[] = [];
  for (const seed of [3, 4, 5, 6]) {
    const { game } = playSync(new ExpectimaxAgent({ depth: 2 }), seed, { maxMoves: 50 + seed * 150 });
    positions.push(game.board.slice());
  }
  for (let k = 0; k < 6; k++) positions.push(randomBoard(55 + gen.below(40), 10));
  positions.push(boardFromHex('fedc89ab76541230'));

  const lines = [0x0000, 0x1111, 0x4321, 0x1234, 0x2020, 0x0f0f, 0xffff, 0x9a9b, 0x1203, 0x3f21];
  for (let k = 0; k < 30; k++) lines.push(gen.below(65536));
  const lineCases = lines.map((v) => ({ line: v, features: lineFeatures(v), canonical: lineTable(HEURISTIC_V1)[v], allWeights: lineTable(ALL)[v] }));

  const evalCases = positions.map((b) => {
    const [lo, hi] = fromBoard(b);
    return {
      board: boardToHex(b),
      canonical: new ExpectimaxSearch().evaluate(lo, hi),
      allWeights: new ExpectimaxSearch({ weights: ALL }).evaluate(lo, hi),
    };
  });

  const bitboardMoves = positions.slice(0, 6).concat([boardFromHex('ff00ff0000000000')]).map((b) => {
    const [lo, hi] = fromBoard(b);
    return {
      board: boardToHex(b),
      results: [0, 1, 2, 3].map((d) => {
        const changed = bbMove(lo, hi, d);
        return { changed, board: boardToHex(toBoard(bb.outLo, bb.outHi)) };
      }),
    };
  });

  const configs: { name: string; config: Record<string, unknown> }[] = [
    { name: 'depth1', config: { depth: 1 } },
    { name: 'depth2', config: { depth: 2 } },
    { name: 'depth3', config: { depth: 3 } },
    { name: 'canonical', config: {} },
    { name: 'prune4-depth2', config: { depth: 2, fourPruneEmpties: 4 } },
    { name: 'allweights-depth2', config: { depth: 2, weights: ALL } },
  ];
  const searchCases = [];
  for (const b of positions) {
    for (const { name, config } of configs) {
      if (name === 'canonical' && positions.indexOf(b) > 4) continue; // keep fixture generation fast
      const s = new ExpectimaxSearch(config);
      const [lo, hi] = fromBoard(b);
      const r = s.search(lo, hi);
      searchCases.push({ board: boardToHex(b), profile: name, config, move: r.move === null ? null : DIRECTION_LETTERS[r.move], depth: r.depth, values: r.values });
    }
  }
  write('ai.json', {
    description: 'AI.md: line features, heuristic tables, board evaluation, saturating bitboard moves and canonical search decisions. Values are float64 and must match to 1e-9 relative (they are bit-identical in conforming ports).',
    weights: { canonical: HEURISTIC_V1, allWeights: ALL },
    lines: lineCases,
    evaluations: evalCases,
    bitboardMoves,
    searches: searchCases,
  });
}

// ------------------------------------------------------- benchmarks.json
{
  const dir = join(specDir, 'benchmarks');
  const expected: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const suite = JSON.parse(readFileSync(join(dir, f), 'utf8')) as BenchmarkSuite;
    if (suite.tags?.includes('heavy') || suite.id === 'engine-random-10k') continue;
    const r = await runSuite(suite, {
      implementation: { language: 'typescript', runtime: 'node', runtimeVersion: process.version, engineVersion: '1.0.0', platform: process.platform },
      environment: {},
    });
    expected[suite.id] = {
      checksum: r.checksum,
      games: r.summary.games,
      totalMoves: r.summary.totalMoves,
      totalScore: r.games.reduce((a, g) => a + g.score, 0),
      maxScore: r.summary.maxScore,
    };
  }
  write('benchmarks.json', {
    description: 'Expected deterministic outcomes of the shared benchmark suites. Every runtime must report the same checksum, move and score totals.',
    suites: expected,
  });
}
