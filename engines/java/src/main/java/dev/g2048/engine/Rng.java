package dev.g2048.engine;

import java.util.Arrays;

/** xoshiro128** seeded via mix32 (SPEC §4). All arithmetic is unsigned 32-bit on Java ints. */
public final class Rng {
  private int s0, s1, s2, s3;

  public Rng(int[] state) {
    s0 = state[0];
    s1 = state[1];
    s2 = state[2];
    s3 = state[3];
  }

  /** Creates a generator from a seed via mix32. */
  public static Rng fromSeed(int seed) {
    return new Rng(mix32(seed));
  }

  /** Expands a seed into generator state (SPEC §4.1). */
  public static int[] mix32(int seed) {
    int[] s = new int[4];
    int x = seed;
    for (int k = 0; k < 4; k++) {
      x += 0x9E3779B9;
      int z = x;
      z = (z ^ (z >>> 16)) * 0x85EBCA6B;
      z = (z ^ (z >>> 13)) * 0xC2B2AE35;
      s[k] = z ^ (z >>> 16);
    }
    if (s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0) s[0] = 1;
    return s;
  }

  /** Next 32-bit output (as a Java int; interpret unsigned). */
  public int next() {
    int result = Integer.rotateLeft(s1 * 5, 7) * 9;
    int t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = Integer.rotateLeft(s3, 11);
    return result;
  }

  /** Unbiased integer in [0, n), 1 <= n <= 2^32 (SPEC §4.3). */
  public long below(long n) {
    final long two32 = 1L << 32;
    long limit = two32 - two32 % n;
    while (true) {
      long x = Integer.toUnsignedLong(next());
      if (x < limit) return x % n;
    }
  }

  /** Copy of the state as unsigned values. */
  public long[] state() {
    return new long[] {
      Integer.toUnsignedLong(s0), Integer.toUnsignedLong(s1), Integer.toUnsignedLong(s2), Integer.toUnsignedLong(s3)
    };
  }

  public Rng copy() {
    return new Rng(new int[] {s0, s1, s2, s3});
  }

  @Override
  public String toString() {
    return Arrays.toString(state());
  }
}
