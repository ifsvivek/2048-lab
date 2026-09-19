/**
 * SPEC §4 — seed expansion (mix32) and xoshiro128**.
 * All arithmetic is uint32; `>>> 0` normalises to unsigned after every step.
 */

export type RngState = [number, number, number, number];

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export function mix32(seed: number): RngState {
  let x = seed >>> 0;
  const s: number[] = [];
  for (let k = 0; k < 4; k++) {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    s.push((z ^ (z >>> 16)) >>> 0);
  }
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s[0] = 1;
  return s as RngState;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: RngState) {
    [this.s0, this.s1, this.s2, this.s3] = state;
  }

  static fromSeed(seed: number): Rng {
    return new Rng(mix32(seed));
  }

  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Unbiased integer in [0, n) by rejection sampling (SPEC §4.3). */
  below(n: number): number {
    const limit = 4294967296 - (4294967296 % n);
    for (;;) {
      const x = this.next();
      if (x < limit) return x % n;
    }
  }

  state(): RngState {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  clone(): Rng {
    return new Rng(this.state());
  }
}
