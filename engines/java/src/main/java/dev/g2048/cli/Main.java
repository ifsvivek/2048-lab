package dev.g2048.cli;

import dev.g2048.ai.Agents;
import dev.g2048.bench.Bench;
import dev.g2048.bench.Suite;
import dev.g2048.engine.Game;
import dev.g2048.engine.Ids;
import dev.g2048.json.Json;
import dev.g2048.validate.Validate;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The Java port's CLI: validate, bench, play. */
public final class Main {
  private Main() {}

  private static final String USAGE = """
      usage: g2048 <command> [flags]

      commands:
        validate [--fixtures DIR] [--json] [--skip-bench]   run every spec fixture check
        bench --suite FILE [--out FILE]                      run a benchmark suite, emit BenchmarkResult JSON
        play --seed N [--agent expectimax|random|greedy] [--depth auto|N] [--max-moves N]
      """;

  /** Thrown for user-facing errors (printed as "error: ..." with exit 1). */
  static final class CliError extends RuntimeException {
    CliError(String m) {
      super(m);
    }
  }

  /** Usage errors exit 2, like Go's flag.ExitOnError. */
  static final class UsageError extends RuntimeException {
    UsageError(String m) {
      super(m);
    }
  }

  public static void main(String[] args) {
    System.setOut(new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), false, StandardCharsets.UTF_8));
    if (args.length < 1) {
      System.err.print(USAGE);
      System.exit(2);
    }
    String[] rest = java.util.Arrays.copyOfRange(args, 1, args.length);
    try {
      switch (args[0]) {
        case "validate" -> cmdValidate(rest);
        case "bench" -> cmdBench(rest);
        case "play" -> cmdPlay(rest);
        case "-h", "--help", "help" -> {
          System.out.print(USAGE);
          System.out.flush();
          return;
        }
        default -> {
          System.err.printf("unknown command \"%s\"%n%n%s", args[0], USAGE);
          System.exit(2);
        }
      }
    } catch (UsageError e) {
      System.err.println(e.getMessage());
      System.err.print(USAGE);
      System.exit(2);
    } catch (Exception e) {
      System.out.flush();
      System.err.println("error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
      System.exit(1);
    }
    System.out.flush();
  }

  /** Go-flag-style parsing: -name / --name, "=value" or separate value; bool flags take no value. */
  static Map<String, String> parseFlags(String cmd, String[] args, Set<String> valueFlags, Set<String> boolFlags) {
    Map<String, String> out = new HashMap<>();
    for (int i = 0; i < args.length; i++) {
      String a = args[i];
      if (!a.startsWith("-") || a.equals("-") ) throw new UsageError(cmd + ": unexpected argument " + a);
      if (a.equals("--")) break;
      String name = a.startsWith("--") ? a.substring(2) : a.substring(1);
      String value = null;
      int eq = name.indexOf('=');
      if (eq >= 0) {
        value = name.substring(eq + 1);
        name = name.substring(0, eq);
      }
      if (name.equals("h") || name.equals("help")) {
        System.out.print(USAGE);
        System.exit(0);
      }
      if (boolFlags.contains(name)) {
        if (value != null && !Set.of("true", "false", "1", "0").contains(value))
          throw new UsageError("invalid boolean value \"" + value + "\" for -" + name);
        out.put(name, value == null ? "true" : String.valueOf(value.equals("true") || value.equals("1")));
      } else if (valueFlags.contains(name)) {
        if (value == null) {
          if (i + 1 >= args.length) throw new UsageError("flag needs an argument: -" + name);
          value = args[++i];
        }
        out.put(name, value);
      } else {
        throw new UsageError("flag provided but not defined: -" + name);
      }
    }
    return out;
  }

  static Path defaultFixtures() {
    for (String c : List.of("../../spec/fixtures", "spec/fixtures", "../spec/fixtures", "../../../spec/fixtures")) {
      if (Files.isDirectory(Path.of(c))) return Path.of(c);
    }
    // also try relative to the jar (engines/java/bin/g2048.jar -> repo/spec/fixtures)
    try {
      Path jar = Path.of(Main.class.getProtectionDomain().getCodeSource().getLocation().toURI());
      Path p = jar.getParent();
      for (int k = 0; k < 5 && p != null; k++, p = p.getParent()) {
        Path f = p.resolve("spec").resolve("fixtures");
        if (Files.isDirectory(f)) return f;
      }
    } catch (Exception ignored) {
    }
    return Path.of("../../spec/fixtures");
  }

  static void cmdValidate(String[] args) {
    var f = parseFlags("validate", args, Set.of("fixtures"), Set.of("json", "skip-bench"));
    Path dir = f.containsKey("fixtures") ? Path.of(f.get("fixtures")) : defaultFixtures();
    boolean asJson = "true".equals(f.get("json"));
    boolean skip = "true".equals(f.get("skip-bench"));
    Validate.Report r = Validate.all(dir, skip);
    if (asJson) {
      System.out.println(Json.write(r.toMap()));
    } else {
      System.out.printf("java engine %s — fixtures: %s%n", Game.ENGINE_VERSION, dir);
      for (String name : Validate.FIXTURES) {
        int[] pf = r.perFixture.get(name);
        if (pf == null) continue;
        System.out.printf("  %-16s %4d passed %4d failed  %s%n", name, pf[0], pf[1], pf[1] > 0 ? "FAIL" : "ok");
      }
      for (var fl : r.failures)
        System.out.printf("  FAIL %s [%s]: %s%n", fl.fixture(), fl.caseName(), fl.message());
      System.out.printf("%d passed, %d failed%n", r.passed, r.failed);
    }
    System.out.flush();
    if (r.failed > 0) System.exit(1);
  }

  static void cmdBench(String[] args) throws Exception {
    var f = parseFlags("bench", args, Set.of("suite", "out"), Set.of());
    String suitePath = f.getOrDefault("suite", "");
    if (suitePath.isEmpty()) throw new CliError("--suite is required");
    Suite suite = Suite.load(Path.of(suitePath));
    Bench.Result res = Bench.run(suite, System.err);
    String data = Bench.toJson(res);
    var s = res.summary();
    System.err.printf("[%s] checksum=%s games=%d moves=%d wall=%.0fms moves/s=%.0f games/s=%.2f nodes/s=%.0f%n",
        suite.id(), res.checksum(), s.games(), s.totalMoves(), s.wallMs(), s.movesPerSec(), s.gamesPerSec(),
        s.nodesPerSec());
    String out = f.get("out");
    if (out == null || out.isEmpty()) {
      System.out.print(data);
      System.out.flush();
      return;
    }
    Path p = Path.of(out);
    if (p.getParent() != null) Files.createDirectories(p.getParent());
    Files.writeString(p, data);
  }

  /** Agent config map from CLI flags. */
  static Map<String, Object> agentConfig(String depth, double budget) {
    Map<String, Object> cfg = new LinkedHashMap<>();
    if (depth != null && !depth.isEmpty() && !depth.equals("auto")) {
      int n;
      try {
        n = Integer.parseInt(depth);
      } catch (NumberFormatException e) {
        n = 0;
      }
      if (n < 1) throw new CliError("--depth must be 'auto' or a positive integer");
      cfg.put("depth", (long) n);
    }
    if (budget > 0) cfg.put("timeBudgetMs", budget);
    return cfg;
  }

  static void cmdPlay(String[] args) {
    var f = parseFlags("play", args, Set.of("seed", "agent", "depth", "max-moves"), Set.of());
    int seed = Ids.randomSeed();
    String seedStr = f.getOrDefault("seed", "");
    if (!seedStr.isEmpty()) {
      try {
        long n = Long.parseLong(seedStr);
        if (n < 0 || n > 0xffffffffL) throw new NumberFormatException();
        seed = (int) n;
      } catch (NumberFormatException e) {
        throw new CliError("--seed must be a uint32");
      }
    }
    String agentId = f.getOrDefault("agent", "expectimax");
    int maxMoves;
    try {
      maxMoves = Integer.parseInt(f.getOrDefault("max-moves", "0"));
    } catch (NumberFormatException e) {
      throw new UsageError("invalid value \"" + f.get("max-moves") + "\" for flag -max-moves");
    }
    var cfg = agentConfig(f.getOrDefault("depth", "auto"), 0);
    Agents.Agent agent = Agents.create(agentId, cfg);
    Bench.PlayResult pr = Bench.play(agent, seed, maxMoves, null);
    Map<String, Object> out = pr.game().snapshot().toMap();
    out.put("specVersion", Game.SPEC_VERSION);
    out.put("agent", agentId);
    out.put("nodes", pr.nodes());
    out.put("wallMs", pr.wallMs());
    out.put("moves", pr.game().moves());
    System.out.println(Json.writeIndent(out, "  "));
  }
}
