import { describe, expect, it } from 'vitest';
import { Game, boardFromHex, boardToHex, classifyGameRef, generateReplayCode, move, moveMotions, normalizeReplayCode, reconstruct, simulate, ulid } from '../src/index.ts';

const line = (hex: string, dir: 0 | 1 | 2 | 3) => boardToHex(move(boardFromHex(hex), dir).board);

describe('SPEC §3 line merge', () => {
  it('merges each tile at most once per move', () => {
    expect(line('1111000000000000', 2)).toBe('2200000000000000');
    expect(line('1120000000000000', 2)).toBe('2200000000000000');
    expect(line('2110000000000000', 2)).toBe('2200000000000000');
    expect(line('1111000000000000', 3)).toBe('0022000000000000');
  });
  it('scores the merged value', () => {
    expect(move(boardFromHex('bb00000000000000'), 2).gained).toBe(4096);
  });
  it('reports invalid moves without changing the board', () => {
    const r = move(boardFromHex('1000000000000000'), 2);
    expect(r.changed).toBe(false);
  });
  it('handles tiles beyond 32768', () => {
    expect(line('gg00000000000000', 2)).toBe('h000000000000000');
  });
});

describe('game lifecycle', () => {
  it('is deterministic for a seed and ignores invalid moves', () => {
    const a = new Game(42);
    const b = new Game(42);
    expect(boardToHex(a.board)).toBe(boardToHex(b.board));
    for (const d of [2, 0, 3, 1, 2, 2, 0] as const) {
      a.apply(d);
      b.apply(d);
    }
    expect(a.historyHash).toBe(b.historyHash);
    expect(a.moves.length).toBe(a.moveCount);
  });
  it('reconstructs full history from seed + moves', () => {
    const g = new Game(9);
    for (let i = 0; i < 30; i++) g.apply((i % 4) as 0) ?? g.apply(((i + 1) % 4) as 0);
    const frames = reconstruct(9, g.moves);
    expect(frames).toHaveLength(g.moveCount + 1);
    expect(boardToHex(frames.at(-1)!.board)).toBe(boardToHex(g.board));
    expect(simulate(9, g.moves).score).toBe(g.score);
  });
  it('produces motions whose destinations match the move', () => {
    const b = boardFromHex('1102000000000000');
    const m = moveMotions(b, 2);
    expect(m.filter((x) => x.merged).map((x) => x.to)).toEqual([0, 0]);
    expect(m.find((x) => x.from === 3)?.to).toBe(1);
  });
});

describe('identifiers', () => {
  it('generates normalisable replay codes', () => {
    for (let i = 0; i < 50; i++) {
      const c = generateReplayCode();
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(normalizeReplayCode(c.toLowerCase())).toBe(c.replace(/-/g, ''));
    }
  });
  it('classifies codes vs game IDs', () => {
    expect(classifyGameRef(ulid())?.kind).toBe('id');
    expect(classifyGameRef('a7kf 29lm xq4p')).toEqual({ kind: 'code', value: 'A7KF-29LM-XQ4P' });
    expect(classifyGameRef('nope')).toBeNull();
  });
});
