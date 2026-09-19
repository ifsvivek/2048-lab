package dev.g2048.ai;

import dev.g2048.engine.Board;
import dev.g2048.engine.Rng;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Built-in agents: SPEC §10 random, greedy, canonical expectimax. */
public final class Agents {
  private Agents() {}

  /** Per-decision metrics (AI.md §4). Optional fields are null for agents without search. */
  public record Metrics(
      Integer depth, Long nodes, Long ttHits, Integer ttSize, long timeUs, Double[] values,
      Heuristic.Breakdown heuristic, boolean deterministic, List<Integer> completedDepths) {
    static Metrics simple(long timeUs) {
      return new Metrics(null, null, null, null, timeUs, null, null, true, null);
    }

    public Map<String, Object> toMap() {
      var m = new LinkedHashMap<String, Object>();
      if (depth != null) m.put("depth", depth);
      if (nodes != null) m.put("nodes", nodes);
      if (ttHits != null) m.put("ttHits", ttHits);
      if (ttSize != null) m.put("ttSize", ttSize);
      m.put("timeUs", timeUs);
      if (values != null) m.put("values", Arrays.asList(values));
      if (heuristic != null) m.put("heuristic", heuristic.toMap());
      m.put("deterministic", deterministic);
      if (completedDepths != null && !completedDepths.isEmpty()) m.put("completedDepths", completedDepths);
      return m;
    }
  }

  /** An agent's chosen move plus metrics. */
  public record Decision(int move, Metrics metrics) {}

  /** Common agent contract. */
  public sealed interface Agent permits RandomAgent, GreedyAgent, ExpectimaxAgent {
    String id();

    /** Called once per game before the first decision. */
    void reset(int seed);

    /** Returns a valid move; only called when at least one move is valid. */
    Decision decide(byte[] board);

    /** Effective configuration (null if none). */
    Map<String, Object> configJson();

    default boolean deterministic() {
      return true;
    }
  }

  /** SPEC §10 reference random agent. */
  public static final class RandomAgent implements Agent {
    private Rng rng = Rng.fromSeed(0);

    public String id() {
      return "random";
    }

    public Map<String, Object> configJson() {
      return null;
    }

    public void reset(int seed) {
      rng = Rng.fromSeed(seed ^ 0xA5A5A5A5);
    }

    public Decision decide(byte[] board) {
      long t = System.nanoTime();
      int v0 = -1, v1 = -1, v2 = -1, v3 = -1;
      int n = 0;
      for (int d = 0; d < 4; d++) {
        if (Board.canMove(board, d)) {
          switch (n++) {
            case 0 -> v0 = d;
            case 1 -> v1 = d;
            case 2 -> v2 = d;
            default -> v3 = d;
          }
        }
      }
      int k = (int) rng.below(n);
      int mv = switch (k) {
        case 0 -> v0;
        case 1 -> v1;
        case 2 -> v2;
        default -> v3;
      };
      return new Decision(mv, Metrics.simple(Search.roundUs(System.nanoTime() - t)));
    }
  }

  /** Maximises empty cells after the move; ties go to the lower direction. */
  public static final class GreedyAgent implements Agent {
    public String id() {
      return "greedy";
    }

    public Map<String, Object> configJson() {
      return null;
    }

    public void reset(int seed) {}

    public Decision decide(byte[] board) {
      long t = System.nanoTime();
      long b = Bitboard.fromBoard(board);
      int[] valid = Board.validMoves(board);
      int best = valid.length > 0 ? valid[0] : -1;
      int bestScore = -1;
      for (int d = 0; d < 4; d++) {
        long nb = Bitboard.move(b, d);
        if (nb == b) continue;
        int empty = Bitboard.countEmpty(nb);
        if (empty > bestScore) {
          bestScore = empty;
          best = d;
        }
      }
      return new Decision(best, Metrics.simple(Search.roundUs(System.nanoTime() - t)));
    }
  }

  /** Wraps {@link Search}. */
  public static final class ExpectimaxAgent implements Agent {
    public final Search search;
    public Search.Result lastResult;

    public ExpectimaxAgent(Config c) {
      search = new Search(c);
    }

    public String id() {
      return "expectimax";
    }

    public Map<String, Object> configJson() {
      return search.config.toMap();
    }

    public void reset(int seed) {}

    public boolean deterministic() {
      return !(search.config.timeBudgetMs > 0);
    }

    public Decision decide(byte[] board) {
      long b = Bitboard.fromBoard(board);
      Search.Result r = search.run(b);
      lastResult = r;
      int mv = r.move();
      if (mv < 0) {
        int[] v = Board.validMoves(board);
        if (v.length > 0) mv = v[0];
      }
      Heuristic.Breakdown h = Heuristic.breakdown(b, search.config.weights);
      return new Decision(mv, new Metrics(r.depth(), r.nodes(), r.ttHits(), r.ttSize(), r.timeUs(), r.values(), h,
          r.deterministic(), r.completedDepths()));
    }
  }

  /** Creates a built-in agent by id ("random", "greedy", "expectimax"). */
  public static Agent create(String id, Map<String, Object> config) {
    return switch (id) {
      case "random" -> new RandomAgent();
      case "greedy" -> new GreedyAgent();
      case "expectimax" -> new ExpectimaxAgent(Config.parse(config));
      default -> throw new IllegalArgumentException("unknown agent '" + id + "'");
    };
  }
}
