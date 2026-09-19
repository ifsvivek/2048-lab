package dev.g2048.ai;

import dev.g2048.json.Json;
import java.util.LinkedHashMap;
import java.util.Map;

/** Expectimax configuration (AI.md §3). Mutable for convenience. */
public final class Config {
  /** depth = clamp(distinct-2, minDepth, maxDepth) when true; otherwise depth is fixed. */
  public boolean autoDepth = true;
  public int depth;
  public int minDepth = 2;
  public int maxDepth = 4;
  public int fourPruneEmpties;
  /** > 0 enables iterative deepening (non-deterministic). */
  public double timeBudgetMs;
  public int ttBits = 20;
  public Heuristic.Weights weights = Heuristic.HEURISTIC_V1;

  public static Config canonical() {
    return new Config();
  }

  /** Renders depth as "auto" or an integer, matching the TS descriptor. */
  public Map<String, Object> toMap() {
    var m = new LinkedHashMap<String, Object>();
    m.put("depth", autoDepth ? "auto" : (Object) (long) depth);
    m.put("minDepth", minDepth);
    m.put("maxDepth", maxDepth);
    m.put("fourPruneEmpties", fourPruneEmpties);
    m.put("timeBudgetMs", timeBudgetMs);
    m.put("ttBits", ttBits);
    m.put("weights", weights.toMap());
    return m;
  }

  private static long asInt(String key, Object v) {
    if (v instanceof Long l) return l;
    if (v instanceof Integer i) return i;
    if (v instanceof Double d) {
      if (d != Math.rint(d) || d.isInfinite()) throw new IllegalArgumentException("config " + key + " must be an integer (got " + d + ")");
      return d.longValue();
    }
    throw new IllegalArgumentException("config " + key + " must be a number");
  }

  /** Overlays a JSON config object onto the canonical profile. */
  public static Config parse(Map<String, Object> m) {
    Config c = canonical();
    if (m == null) return c;
    for (var e : m.entrySet()) {
      String k = e.getKey();
      Object v = e.getValue();
      switch (k) {
        case "depth" -> {
          if (v instanceof String s) {
            if (!s.equals("auto")) throw new IllegalArgumentException("config depth must be an integer or \"auto\"");
            c.autoDepth = true;
          } else {
            long n = asInt(k, v);
            if (n < 1) throw new IllegalArgumentException("config depth must be >= 1");
            c.autoDepth = false;
            c.depth = (int) n;
          }
        }
        case "minDepth" -> c.minDepth = (int) asInt(k, v);
        case "maxDepth" -> c.maxDepth = (int) asInt(k, v);
        case "fourPruneEmpties" -> c.fourPruneEmpties = (int) asInt(k, v);
        case "timeBudgetMs" -> {
          if (!(v instanceof Number n)) throw new IllegalArgumentException("config timeBudgetMs must be a number");
          c.timeBudgetMs = n.doubleValue();
        }
        case "ttBits" -> {
          long n = asInt(k, v);
          if (n < 4 || n > 28) throw new IllegalArgumentException("config ttBits out of range");
          c.ttBits = (int) n;
        }
        case "weights" -> {
          if (!(v instanceof Map<?, ?>)) throw new IllegalArgumentException("config weights must be an object");
          for (var we : Json.obj(v).entrySet()) {
            long n;
            try {
              n = asInt("weights." + we.getKey(), we.getValue());
            } catch (IllegalArgumentException ex) {
              throw new IllegalArgumentException(
                  "heuristic weight '" + we.getKey() + "' must be an integer (got " + we.getValue() + ")");
            }
            c.weights = c.weights.with(we.getKey(), n);
          }
        }
        default -> {}
      }
    }
    return c;
  }
}
