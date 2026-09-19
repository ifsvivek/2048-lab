package dev.g2048.ai;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Integer heuristic (AI.md §2). */
public final class Heuristic {
  private Heuristic() {}

  /** Integer heuristic weights. */
  public record Weights(long lost, long empty, long merges, long mono, long sum, long smooth, long stable, long corner) {
    public Map<String, Object> toMap() {
      var m = new LinkedHashMap<String, Object>();
      m.put("lost", lost);
      m.put("empty", empty);
      m.put("merges", merges);
      m.put("mono", mono);
      m.put("sum", sum);
      m.put("smooth", smooth);
      m.put("stable", stable);
      m.put("corner", corner);
      return m;
    }

    public Weights with(String key, long v) {
      return switch (key) {
        case "lost" -> new Weights(v, empty, merges, mono, sum, smooth, stable, corner);
        case "empty" -> new Weights(lost, v, merges, mono, sum, smooth, stable, corner);
        case "merges" -> new Weights(lost, empty, v, mono, sum, smooth, stable, corner);
        case "mono" -> new Weights(lost, empty, merges, v, sum, smooth, stable, corner);
        case "sum" -> new Weights(lost, empty, merges, mono, v, smooth, stable, corner);
        case "smooth" -> new Weights(lost, empty, merges, mono, sum, v, stable, corner);
        case "stable" -> new Weights(lost, empty, merges, mono, sum, smooth, v, corner);
        case "corner" -> new Weights(lost, empty, merges, mono, sum, smooth, stable, v);
        default -> this;
      };
    }

    public static Weights fromMap(Map<String, Object> m) {
      Weights w = new Weights(0, 0, 0, 0, 0, 0, 0, 0);
      for (var e : m.entrySet()) w = w.with(e.getKey(), dev.g2048.json.Json.lng(e.getValue()));
      return w;
    }
  }

  /** Canonical profile HEURISTIC_V1. */
  public static final Weights HEURISTIC_V1 = new Weights(200000, 270, 700, 47, 11, 0, 0, 0);

  /** Per-line features. */
  public record LineFeatures(long empty, long merges, long mono, long sum, long smooth, long stable) {
    public LineFeatures plus(LineFeatures o) {
      return new LineFeatures(
          empty + o.empty, merges + o.merges, mono + o.mono, sum + o.sum, smooth + o.smooth, stable + o.stable);
    }

    public Map<String, Object> toMap() {
      var m = new LinkedHashMap<String, Object>();
      m.put("empty", empty);
      m.put("merges", merges);
      m.put("mono", mono);
      m.put("sum", sum);
      m.put("smooth", smooth);
      m.put("stable", stable);
      return m;
    }
  }

  public static LineFeatures features(int v) {
    long[] r = {v & 0xf, (v >>> 4) & 0xf, (v >>> 8) & 0xf, (v >>> 12) & 0xf};
    long empty = 0, merges = 0, sum = 0, smooth = 0, stable = 0;
    long prev = 0, counter = 0;
    for (long rank : r) {
      sum += rank * rank * rank;
      if (rank == 0) {
        empty++;
        continue;
      }
      if (prev == rank) counter++;
      else if (counter > 0) {
        merges += 1 + counter;
        counter = 0;
      }
      prev = rank;
    }
    if (counter > 0) merges += 1 + counter;
    long monoL = 0, monoR = 0;
    for (int i = 1; i < 4; i++) {
      long a = r[i - 1] * r[i - 1] * r[i - 1] * r[i - 1];
      long b = r[i] * r[i] * r[i] * r[i];
      if (r[i - 1] > r[i]) monoL += a - b;
      else monoR += b - a;
      if (r[i - 1] != 0 && r[i] != 0) smooth += Math.abs(r[i - 1] - r[i]);
    }
    if (empty == 0 && (monoL == 0 || monoR == 0)) stable = 1;
    return new LineFeatures(empty, merges, Math.min(monoL, monoR), sum, smooth, stable);
  }

  public static long lineScore(LineFeatures f, Weights w) {
    return w.lost() + w.empty() * f.empty() + w.merges() * f.merges() - w.mono() * f.mono() - w.sum() * f.sum()
        - w.smooth() * f.smooth() + w.stable() * f.stable();
  }

  private static final Map<Weights, double[]> TABLES = new ConcurrentHashMap<>();

  /** Memoised 65536-entry per-line score table. */
  public static double[] lineTable(Weights w) {
    return TABLES.computeIfAbsent(w, k -> {
      double[] t = new double[65536];
      for (int v = 0; v < 65536; v++) t[v] = (double) lineScore(features(v), k);
      return t;
    });
  }

  public static double cornerTerm(long b, long cornerWeight) {
    if (cornerWeight == 0) return 0;
    long mx = 0;
    for (int i = 0; i < 16; i++) {
      long n = (b >>> (4 * i)) & 0xf;
      if (n > mx) mx = n;
    }
    if ((b & 0xf) == mx || ((b >>> 12) & 0xf) == mx || ((b >>> 48) & 0xf) == mx || (b >>> 60) == mx)
      return (double) (cornerWeight * mx);
    return 0;
  }

  public static double evaluate(long b, double[] t, long cornerWeight) {
    long c = Bitboard.transpose(b); // rows of c are the columns of b, in order
    double v = t[(int) (b & 0xffff)] + t[(int) ((b >>> 16) & 0xffff)] + t[(int) ((b >>> 32) & 0xffff)]
        + t[(int) (b >>> 48)] + t[(int) (c & 0xffff)] + t[(int) ((c >>> 16) & 0xffff)]
        + t[(int) ((c >>> 32) & 0xffff)] + t[(int) (c >>> 48)];
    if (cornerWeight != 0) v += cornerTerm(b, cornerWeight);
    return v;
  }

  /** Heuristic decomposition summed over all 8 lines. */
  public record Breakdown(LineFeatures features, double corner, double total) {
    public Map<String, Object> toMap() {
      var m = features.toMap();
      m.put("corner", corner);
      m.put("total", total);
      return m;
    }
  }

  public static Breakdown breakdown(long b, Weights w) {
    int[] lines = {
      (int) (b & 0xffff), (int) ((b >>> 16) & 0xffff), (int) ((b >>> 32) & 0xffff), (int) (b >>> 48),
      Bitboard.column(b, 0), Bitboard.column(b, 1), Bitboard.column(b, 2), Bitboard.column(b, 3)
    };
    LineFeatures acc = new LineFeatures(0, 0, 0, 0, 0, 0);
    for (int v : lines) acc = acc.plus(features(v));
    return new Breakdown(acc, cornerTerm(b, w.corner()), evaluate(b, lineTable(w), w.corner()));
  }
}
