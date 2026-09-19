import { describe, expect, it } from 'vitest';
import { binHigh, binLow, clampTo, histBin, histPercentile, percentiles } from '../src/lib/analytics.ts';

describe('log-scale histogram', () => {
  it('bins are contiguous and contain their values', () => {
    for (const x of [0, 1, 2, 3, 100, 2048, 20480, 131072, 3_932_100]) {
      const b = histBin(x);
      expect(binLow(b)).toBeLessThanOrEqual(x + 1e-9);
      expect(binHigh(b)).toBeGreaterThan(x);
    }
  });
  it('percentiles are within ~10% of exact values on a uniform-ish sample', () => {
    const xs = Array.from({ length: 5000 }, (_, i) => 500 + ((i * 7919) % 20000));
    const h = new Map<number, number>();
    for (const x of xs) h.set(histBin(x), (h.get(histBin(x)) ?? 0) + 1);
    const hist = [...h].map(([bin, n]) => ({ bin, n }));
    const sorted = [...xs].sort((a, b) => a - b);
    // The API always clamps into the exact [min, max] it tracks (handles a partially filled top bin).
    const p = percentiles(hist, sorted[0], sorted[sorted.length - 1]);
    for (const [q, key] of [[0.5, 'p50'], [0.9, 'p90'], [0.99, 'p99']] as const) {
      const exact = sorted[Math.floor(q * sorted.length)];
      expect(Math.abs(p[key]! - exact) / exact).toBeLessThan(0.1);
    }
    expect(Math.abs(histPercentile(hist, 0.5)! - sorted[2500]) / sorted[2500]).toBeLessThan(0.01);
  });
  it('clamps approximations into the exact [min, max]', () => {
    const hist = [{ bin: histBin(80756), n: 1 }];
    const p = percentiles(hist, 80756, 80756);
    expect(p.p99).toBe(80756);
    expect(clampTo(5, 10, 20)).toBe(10);
    expect(clampTo(null, 1, 2)).toBeNull();
  });
});
