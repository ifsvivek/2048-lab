package dev.g2048.ai;

import java.util.ArrayList;
import java.util.List;

/**
 * Reusable canonical expectimax searcher (AI.md §3). Not thread-safe.
 *
 * <p>The transposition table mirrors the TypeScript reference (slot hash, 4-slot linear probe,
 * store policy, clear at 75% occupancy) so node and hit counts are comparable across ports.
 */
public final class Search {
  /** Outcome of one search. move is -1 if no valid move; values[d] is null for invalid moves. */
  public record Result(
      int move, double value, Double[] values, int depth, long nodes, long ttHits, int ttSize, long timeUs,
      boolean deterministic, List<Integer> completedDepths) {}

  public final Config config;
  private final double[] table;
  private final long corner;

  // transposition table
  private final int mask;
  private final long[] ttBoard;
  private final byte[] ttDepth;
  private final double[] ttValue;
  private int ttSize;

  private long nodes, ttHits;
  private long deadlineNs;
  private boolean timed, aborted;

  public Search(Config c) {
    if (c.ttBits == 0) c.ttBits = 20;
    this.config = c;
    this.table = Heuristic.lineTable(c.weights);
    this.corner = c.weights.corner();
    int n = 1 << c.ttBits;
    this.mask = n - 1;
    this.ttBoard = new long[n];
    this.ttDepth = new byte[n];
    this.ttValue = new double[n];
  }

  public double evaluate(long b) {
    return Heuristic.evaluate(b, table, corner);
  }

  public int depthFor(long b) {
    if (!config.autoDepth) return config.depth;
    return Math.max(config.minDepth, Math.min(config.maxDepth, Bitboard.distinctRanks(b) - 2));
  }

  private int slot(long b, int d) {
    int lo = (int) b, hi = (int) (b >>> 32);
    int h = ((lo ^ d * 0x9e3779b1) * 0x85ebca6b) ^ (hi * 0xc2b2ae35);
    h ^= h >>> 15;
    h *= 0x2c1b3c6d;
    h ^= h >>> 12;
    return h & mask;
  }

  private double maxnode(long b, int d) {
    nodes++;
    if (d == 0) return Heuristic.evaluate(b, table, corner);
    double best = 0.0;
    for (int dir = 0; dir < 4; dir++) {
      long nb = Bitboard.move(b, dir);
      if (nb == b) continue;
      double v = chance(nb, d);
      if (aborted) return 0;
      if (v > best) best = v;
    }
    return best;
  }

  private double chance(long b, int d) {
    nodes++;
    if (timed && (nodes & 0xfff) == 0 && System.nanoTime() - deadlineNs > 0) {
      aborted = true;
      return 0;
    }
    final int home = slot(b, d);
    int sl = home;
    for (int probe = 0; probe < 4; probe++) {
      int sd = ttDepth[sl];
      if (sd == 0) break;
      if (sd == d && ttBoard[sl] == b) {
        ttHits++;
        return ttValue[sl];
      }
      sl = (sl + 1) & mask;
    }

    long empties = Bitboard.emptyMask(b); // ascending cell order == lowest set bit first
    int n = Long.bitCount(empties);
    int p = config.fourPruneEmpties;
    boolean four = !(p > 0 && n >= p);
    double sum = 0.0;
    while (empties != 0) {
      long bit = empties & -empties; // value 1 in the empty nibble
      empties ^= bit;
      if (four) {
        double v2 = maxnode(b | bit, d - 1);
        if (aborted) return 0;
        sum = sum + 0.9 * v2;
        double v4 = maxnode(b | bit << 1, d - 1);
        if (aborted) return 0;
        sum = sum + 0.1 * v4;
      } else {
        double v2 = maxnode(b | bit, d - 1);
        if (aborted) return 0;
        sum = sum + v2;
      }
    }
    double v = sum / n;

    int target = home;
    sl = home;
    for (int probe = 0; probe < 4; probe++) {
      if (ttDepth[sl] == 0) {
        target = sl;
        ttSize++;
        break;
      }
      sl = (sl + 1) & mask;
    }
    ttBoard[target] = b;
    ttDepth[target] = (byte) d;
    ttValue[target] = v;
    return v;
  }

  private record Root(int move, double value, Double[] values) {}

  /** Returns null when aborted by the time budget. */
  private Root root(long b, int depth) {
    int move = -1;
    double value = Double.NEGATIVE_INFINITY;
    Double[] values = new Double[4];
    for (int dir = 0; dir < 4; dir++) {
      long nb = Bitboard.move(b, dir);
      if (nb == b) continue;
      double v = chance(nb, depth);
      if (aborted) return null;
      values[dir] = v;
      if (v > value) {
        value = v;
        move = dir;
      }
    }
    return new Root(move, value, values);
  }

  /** Searches b and returns the decision. */
  public Result run(long b) {
    long start = System.nanoTime();
    nodes = 0;
    ttHits = 0;
    aborted = false;
    timed = false;
    if ((double) ttSize > (double) (mask + 1L) * 0.75) {
      java.util.Arrays.fill(ttDepth, (byte) 0);
      ttSize = 0;
    }
    if (config.timeBudgetMs <= 0) {
      int depth = depthFor(b);
      Root r = root(b, depth);
      return result(r, depth, start, true, List.of(depth));
    }
    Root best = root(b, 1);
    int depth = 1;
    List<Integer> completed = new ArrayList<>(List.of(1));
    timed = true;
    deadlineNs = start + (long) (config.timeBudgetMs * 1e6);
    for (int d = 2; d <= config.maxDepth; d++) {
      Root r = root(b, d);
      if (r == null) break;
      best = r;
      depth = d;
      completed.add(d);
    }
    timed = false;
    aborted = false;
    return result(best, depth, start, false, completed);
  }

  private Result result(Root r, int depth, long start, boolean det, List<Integer> completed) {
    return new Result(r.move, r.value, r.values, depth, nodes, ttHits, ttSize, roundUs(System.nanoTime() - start), det,
        completed);
  }

  static long roundUs(long ns) {
    return Math.round(ns / 1000.0);
  }
}
