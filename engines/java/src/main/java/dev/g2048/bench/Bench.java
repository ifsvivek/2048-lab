package dev.g2048.bench;

import dev.g2048.ai.Agents;
import dev.g2048.ai.Agents.Agent;
import dev.g2048.engine.Board;
import dev.g2048.engine.Game;
import dev.g2048.engine.Hash;
import dev.g2048.json.Json;
import java.io.IOException;
import java.io.PrintStream;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.LongConsumer;

/** Benchmark-suite runner producing BenchmarkResult JSON (spec/schemas/benchmark-result.schema.json). */
public final class Bench {
  private Bench() {}

  public static final long[] REACH_TILES = {2048, 4096, 8192, 16384, 32768, 65536};

  /** One game's outcome. */
  public record GameResult(
      long seed, long score, long maxTile, int moveCount, boolean over, String historyHash, double wallMs, long nodes) {
    Map<String, Object> toMap() {
      var m = new LinkedHashMap<String, Object>();
      m.put("seed", seed);
      m.put("score", score);
      m.put("maxTile", maxTile);
      m.put("moveCount", moveCount);
      m.put("over", over);
      m.put("historyHash", historyHash);
      m.put("wallMs", wallMs);
      m.put("nodes", nodes);
      return m;
    }
  }

  /** Aggregate statistics (definitions match the TS sim.ts / Go port). */
  public record Summary(
      int games, double avgScore, double medianScore, long minScore, long maxScore, long maxTile, long totalMoves,
      double wallMs, Double cpuMs, double gamesPerSec, double movesPerSec, double decisionsPerSec, long nodes,
      double nodesPerSec, Long peakMemoryBytes, Double avgDecisionUs, Double p50DecisionUs, Double p99DecisionUs,
      TreeMap<Long, Integer> tileDistribution, Map<Long, Double> reachRates) {
    Map<String, Object> toMap() {
      var m = new LinkedHashMap<String, Object>();
      m.put("games", games);
      m.put("avgScore", avgScore);
      m.put("medianScore", medianScore);
      m.put("minScore", minScore);
      m.put("maxScore", maxScore);
      m.put("maxTile", maxTile);
      m.put("totalMoves", totalMoves);
      m.put("wallMs", wallMs);
      m.put("cpuMs", cpuMs);
      m.put("gamesPerSec", gamesPerSec);
      m.put("movesPerSec", movesPerSec);
      m.put("decisionsPerSec", decisionsPerSec);
      m.put("nodes", nodes);
      m.put("nodesPerSec", nodesPerSec);
      m.put("peakMemoryBytes", peakMemoryBytes);
      m.put("avgDecisionUs", avgDecisionUs);
      m.put("p50DecisionUs", p50DecisionUs);
      m.put("p99DecisionUs", p99DecisionUs);
      var td = new LinkedHashMap<String, Object>();
      tileDistribution.forEach((k, v) -> td.put(Long.toString(k), v));
      m.put("tileDistribution", td);
      var rr = new LinkedHashMap<String, Object>();
      reachRates.forEach((k, v) -> rr.put(Long.toString(k), v));
      m.put("reachRates", rr);
      return m;
    }
  }

  /** A BenchmarkResult. */
  public record Result(
      String suiteId, Map<String, Object> implementation, Map<String, Object> environment, String agentId,
      Map<String, Object> agentConfig, boolean deterministic, String startedAt, String finishedAt,
      List<GameResult> games, Summary summary, String checksum) {
    public Map<String, Object> toMap() {
      var m = new LinkedHashMap<String, Object>();
      m.put("schemaVersion", 1);
      m.put("suiteId", suiteId);
      m.put("specVersion", Game.SPEC_VERSION);
      m.put("implementation", implementation);
      m.put("environment", environment);
      var agent = new LinkedHashMap<String, Object>();
      agent.put("id", agentId);
      if (agentConfig != null) agent.put("config", agentConfig);
      m.put("agent", agent);
      m.put("deterministic", deterministic);
      m.put("startedAt", startedAt);
      m.put("finishedAt", finishedAt);
      List<Object> gs = new ArrayList<>(games.size());
      for (GameResult g : games) gs.add(g.toMap());
      m.put("games", gs);
      m.put("summary", summary.toMap());
      m.put("checksum", checksum);
      return m;
    }
  }

  /** Outcome of {@link #play}. */
  public record PlayResult(Game game, long nodes, double wallMs) {}

  /** Runs an agent on seed until the game ends or maxMoves (0 = unlimited). */
  public static PlayResult play(Agent agent, int seed, int maxMoves, LongConsumer onDecision) {
    long t0 = System.nanoTime();
    Game g = new Game(seed);
    agent.reset(g.seed);
    long nodes = 0;
    while ((maxMoves <= 0 || g.moveCount < maxMoves) && !g.over()) {
      Agents.Decision d = agent.decide(g.board);
      if (d.move() < 0)
        throw new IllegalStateException("agent " + agent.id() + " returned no move at " + g.moveCount);
      if (g.apply(d.move()) < 0)
        throw new IllegalStateException(
            "agent " + agent.id() + " returned invalid move " + d.move() + " at " + g.moveCount);
      if (d.metrics().nodes() != null) nodes += d.metrics().nodes();
      if (onDecision != null) onDecision.accept(d.metrics().timeUs());
    }
    return new PlayResult(g, nodes, msSince(t0));
  }

  static double msSince(long t0) {
    return (System.nanoTime() - t0) / 1e6;
  }

  static double percentile(double[] sorted, double p) {
    if (sorted.length == 0) return 0;
    return sorted[Math.min(sorted.length - 1, (int) Math.floor(p * sorted.length))];
  }

  public static Summary summarise(List<GameResult> games, double wallMs, Double cpuMs, Long peak, double[] decisions) {
    int n = games.size();
    long[] scores = new long[n];
    long total = 0, totalMoves = 0, nodes = 0, maxTile = 0;
    TreeMap<Long, Integer> dist = new TreeMap<>();
    for (int i = 0; i < n; i++) {
      GameResult g = games.get(i);
      scores[i] = g.score();
      total += g.score();
      totalMoves += g.moveCount();
      nodes += g.nodes();
      maxTile = Math.max(maxTile, g.maxTile());
      dist.merge(g.maxTile(), 1, Integer::sum);
    }
    Arrays.sort(scores);
    double avg = 0, median = 0;
    long min = 0, max = 0;
    if (n > 0) {
      avg = (double) total / n;
      median = scores[n / 2];
      min = scores[0];
      max = scores[n - 1];
    }
    Map<Long, Double> reach = new LinkedHashMap<>();
    for (long t : REACH_TILES) {
      double r = 0;
      if (n > 0) {
        int c = 0;
        for (GameResult g : games) if (g.maxTile() >= t) c++;
        r = (double) c / n;
      }
      reach.put(t, r);
    }
    double secs = wallMs / 1000;
    double gps = 0, mps = 0, nps = 0;
    if (secs > 0) {
      gps = n / secs;
      mps = totalMoves / secs;
      nps = nodes / secs;
    }
    Double avgUs = null, p50 = null, p99 = null;
    if (decisions != null && decisions.length > 0) {
      double[] sorted = decisions.clone();
      Arrays.sort(sorted);
      double sum = 0;
      for (double x : sorted) sum += x;
      avgUs = sum / sorted.length;
      p50 = percentile(sorted, 0.5);
      p99 = percentile(sorted, 0.99);
    }
    return new Summary(n, avg, median, min, max, maxTile, totalMoves, wallMs, cpuMs, gps, mps, mps, nodes, nps, peak,
        avgUs, p50, p99, dist, reach);
  }

  /** fnv1a32 over the concatenated historyHash strings. */
  public static String checksum(List<GameResult> games) {
    StringBuilder sb = new StringBuilder(games.size() * 8);
    for (GameResult g : games) sb.append(g.historyHash());
    return Hash.hex(Hash.fnv1a32(sb.toString().getBytes(StandardCharsets.US_ASCII)));
  }

  static String platform() {
    String os = System.getProperty("os.name", "").toLowerCase();
    if (os.contains("linux")) return "linux";
    if (os.contains("mac") || os.contains("darwin")) return "darwin";
    if (os.contains("win")) return "win32";
    if (os.contains("freebsd")) return "freebsd";
    return os.replace(' ', '-');
  }

  static String arch() {
    String a = System.getProperty("os.arch", "");
    return switch (a) {
      case "x86_64", "amd64" -> "amd64";
      case "aarch64" -> "arm64";
      default -> a;
    };
  }

  public static Map<String, Object> implementationInfo() {
    var m = new LinkedHashMap<String, Object>();
    m.put("language", "java");
    m.put("runtime", "jvm");
    m.put("runtimeVersion", System.getProperty("java.version", "unknown"));
    m.put("engineVersion", Game.ENGINE_VERSION);
    m.put("platform", platform());
    return m;
  }

  /** Host facts (keys sorted, like Go's map encoding). */
  public static Map<String, Object> environment() {
    var env = new TreeMap<String, Object>();
    env.put("os", platform());
    env.put("arch", arch());
    env.put("cpus", Runtime.getRuntime().availableProcessors());
    env.put("vm", System.getProperty("java.vm.name", "") + " " + System.getProperty("java.vm.version", ""));
    env.put("gc", gcNames());
    try {
      for (String line : Files.readAllLines(Path.of("/proc/cpuinfo"))) {
        int c = line.indexOf(':');
        if (c > 0 && line.substring(0, c).trim().equals("model name")) {
          env.put("cpu", line.substring(c + 1).trim());
          break;
        }
      }
    } catch (IOException | RuntimeException ignored) {
    }
    try {
      for (String line : Files.readAllLines(Path.of("/proc/meminfo"))) {
        if (line.startsWith("MemTotal:")) {
          env.put("memoryBytes", Long.parseLong(line.replaceAll("[^0-9]", "")) * 1024);
          break;
        }
      }
    } catch (IOException | RuntimeException ignored) {
    }
    return env;
  }

  private static String gcNames() {
    List<String> names = new ArrayList<>();
    for (var gc : ManagementFactory.getGarbageCollectorMXBeans()) names.add(gc.getName());
    return String.join(", ", names);
  }

  static String isoNow() {
    return DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC).format(Instant.now());
  }

  /** Process CPU time (all threads, user+sys) in ms, or null if unavailable. */
  static Double cpuMs() {
    try {
      if (ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean os) {
        long ns = os.getProcessCpuTime();
        if (ns >= 0) return ns / 1e6;
      }
    } catch (Throwable ignored) {
    }
    return null;
  }

  /**
   * Peak resident set size in bytes (VmHWM from /proc/self/status, comparable to getrusage
   * maxrss in other ports); falls back to the sum of JVM memory-pool peaks.
   */
  static Long peakMemory() {
    try {
      for (String line : Files.readAllLines(Path.of("/proc/self/status"))) {
        if (line.startsWith("VmHWM:")) return Long.parseLong(line.replaceAll("[^0-9]", "")) * 1024;
      }
    } catch (IOException | RuntimeException ignored) {
    }
    try {
      long sum = 0;
      for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
        var u = p.getPeakUsage();
        if (u != null) sum += u.getUsed();
      }
      return sum;
    } catch (Throwable ignored) {
      return null;
    }
  }

  /** Executes a suite. Progress lines go to progress (may be null). */
  public static Result run(Suite suite, PrintStream progress) {
    if (suite.specVersion() != Game.SPEC_VERSION)
      throw new IllegalArgumentException("suite " + suite.id() + " targets spec v" + suite.specVersion());
    Agent agent = Agents.create(suite.agentId(), suite.agentConfig());
    String startedAt = isoNow();
    Double cpu0 = cpuMs();
    long t0 = System.nanoTime();
    final double[][] buf = {suite.timeDecisions() ? new double[1024] : null};
    final int[] nDec = {0};
    LongConsumer onDecision = null;
    if (suite.timeDecisions()) {
      onDecision = us -> {
        if (nDec[0] == buf[0].length) buf[0] = Arrays.copyOf(buf[0], buf[0].length * 2);
        buf[0][nDec[0]++] = us;
      };
    }
    List<GameResult> games = new ArrayList<>(suite.seedCount());
    for (int i = 0; i < suite.seedCount(); i++) {
      long seed = (suite.seedStart() + i) & 0xffffffffL;
      PlayResult pr = play(agent, (int) seed, suite.maxMoves(), onDecision);
      Game g = pr.game();
      GameResult r = new GameResult(seed, g.score, 1L << Board.maxExponent(g.board), g.moveCount, g.over(),
          g.historyHash(), pr.wallMs(), pr.nodes());
      games.add(r);
      if (progress != null && (suite.seedCount() <= 100 || (i + 1) % 100 == 0 || i + 1 == suite.seedCount())) {
        progress.printf("[%s] game %d/%d seed=%d score=%d maxTile=%d moves=%d %.0fms%n", suite.id(), i + 1,
            suite.seedCount(), seed, r.score(), r.maxTile(), r.moveCount(), r.wallMs());
      }
    }
    double wallMs = msSince(t0);
    Double cpu1 = cpuMs();
    Double cpu = (cpu0 != null && cpu1 != null) ? cpu1 - cpu0 : null;
    double[] decs = suite.timeDecisions() ? Arrays.copyOf(buf[0], nDec[0]) : null;
    return new Result(suite.id(), implementationInfo(), environment(), suite.agentId(), suite.agentConfig(),
        agent.deterministic(), startedAt, isoNow(), games, summarise(games, wallMs, cpu, peakMemory(), decs),
        checksum(games));
  }

  /** Serialises a result like Go's MarshalIndent(res, "", "  ") plus a trailing newline. */
  public static String toJson(Result r) {
    return Json.writeIndent(r.toMap(), "  ") + "\n";
  }
}
