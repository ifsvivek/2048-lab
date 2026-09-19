import { describe, expect, it } from 'vitest';
import { runFixtureChecks } from './fixture-checks.ts';

describe('spec fixtures', () => {
  it('TypeScript engine matches every cross-language fixture', async () => {
    const r = await runFixtureChecks();
    expect(r.failures).toEqual([]);
    expect(r.passed).toBeGreaterThan(1000);
  }, 120_000);
});
