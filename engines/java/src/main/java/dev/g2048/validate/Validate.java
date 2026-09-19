package dev.g2048.validate;

import static dev.g2048.json.Json.arr;
import static dev.g2048.json.Json.bool;
import static dev.g2048.json.Json.dbl;
import static dev.g2048.json.Json.lng;
import static dev.g2048.json.Json.obj;
import static dev.g2048.json.Json.str;

import dev.g2048.ai.Agents;
import dev.g2048.ai.Bitboard;
import dev.g2048.ai.Config;
import dev.g2048.ai.Heuristic;
import dev.g2048.ai.Search;
import dev.g2048.bench.Bench;
import dev.g2048.bench.Suite;
import dev.g2048.engine.Board;
import dev.g2048.engine.Game;
import dev.g2048.engine.Hash;
import dev.g2048.engine.Ids;
import dev.g2048.engine.Replay;
import dev.g2048.engine.Rng;
import dev.g2048.json.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/** Checks this port against the cross-language fixtures in spec/fixtures (mirrors the Go validator). */
public final class Validate {
  private Validate() {}

  /** One failed fixture case. */
  public record Failure(String fixture, String caseName, String message) {}

  /** Accumulated results. */
  public static final class Report {
    public int passed, failed;
    public final List<Failure> failures = new ArrayList<>();
    /** fixture -> {passed, failed}. */
    public final Map<String, int[]> perFixture = new LinkedHashMap<>();

    boolean check(String fixture, String name, boolean ok, String msg) {
      int[] pf = perFixture.computeIfAbsent(fixture, k -> new int[2]);
      if (ok) {
        passed++;
        pf[0]++;
      } else {
        failed++;
        pf[1]++;
        failures.add(new Failure(fixture, name, msg));
      }
      return ok;
    }

    void fail(String fixture, String name, String msg) {
      check(fixture, name, false, msg);
    }

    public Map<String, Object> toMap() {
      var m = new LinkedHashMap<String, Object>();
      m.put("language", "java");
      m.put("engineVersion", Game.ENGINE_VERSION);
      m.put("passed", passed);
      m.put("failed", failed);
      List<Object> fs = new ArrayList<>();
      for (Failure f : failures) {
        var fm = new LinkedHashMap<String, Object>();
        fm.put("fixture", f.fixture());
        fm.put("case", f.caseName());
        fm.put("message", f.message());
        fs.add(fm);
      }
      m.put("failures", fs);
      return m;
    }
  }

  /** Fixture files in check order. */
  public static final List<String> FIXTURES = List.of("rng.json", "moves.json", "spawn.json", "hash.json",
      "games.json", "replays.json", "codes.json", "ai.json", "benchmarks.json");

  /** Informational: search values that were bit-identical. */
  public static int aiExact, aiTotal;

  public static Report all(Path dir, boolean skipBenchmarks) {
    Report r = new Report();
    for (String f : FIXTURES) {
      if (f.equals("benchmarks.json") && skipBenchmarks) continue;
      run(r, dir, f);
    }
    return r;
  }

  @FunctionalInterface
  private interface Check {
    void run(Report r, Path dir) throws Exception;
  }

  public static void run(Report r, Path dir, String name) {
    Check c = switch (name) {
      case "rng.json" -> Validate::checkRng;
      case "moves.json" -> Validate::checkMoves;
      case "spawn.json" -> Validate::checkSpawn;
      case "hash.json" -> Validate::checkHash;
      case "games.json" -> Validate::checkGames;
      case "replays.json" -> Validate::checkReplays;
      case "codes.json" -> Validate::checkCodes;
      case "ai.json" -> Validate::checkAI;
      case "benchmarks.json" -> Validate::checkBenchmarks;
      default -> (rr, d) -> {
        throw new IllegalArgumentException("unknown fixture");
      };
    };
    try {
      c.run(r, dir);
    } catch (java.nio.file.NoSuchFileException e) {
      r.fail(name, "load", "open " + e.getFile() + ": no such file or directory");
    } catch (Exception e) {
      r.fail(name, "load", String.valueOf(e.getMessage() != null ? e.getMessage() : e));
    }
  }

  private static Map<String, Object> load(Path dir, String name) throws Exception {
    return obj(Json.parse(Files.readString(dir.resolve(name))));
  }

  private static int u32(Object o) {
    return (int) lng(o);
  }

  private static int[] state(Object o) {
    List<Object> l = arr(o);
    int[] s = new int[4];
    for (int i = 0; i < 4; i++) s[i] = u32(l.get(i));
    return s;
  }

  private static long[] ustate(int[] s) {
    long[] o = new long[4];
    for (int i = 0; i < 4; i++) o[i] = Integer.toUnsignedLong(s[i]);
    return o;
  }

  // ------------------------------------------------------------------ rng

  private static void checkRng(Report r, Path dir) throws Exception {
    final String F = "rng.json";
    for (Object co : arr(load(dir, F).get("cases"))) {
      var c = obj(co);
      long seedU = lng(c.get("seed"));
      int seed = (int) seedU;
      String id = "seed=" + seedU;
      int[] st = Rng.mix32(seed);
      int[] want = state(c.get("state"));
      r.check(F, id + " state", Arrays.equals(st, want),
          "state " + Arrays.toString(ustate(st)) + ", want " + Arrays.toString(ustate(want)));
      Rng g = new Rng(st);
      List<Object> next = arr(c.get("next"));
      boolean nextOk = true;
      for (int i = 0; i < next.size(); i++) {
        long got = Integer.toUnsignedLong(g.next());
        long w = lng(next.get(i));
        if (got != w) {
          r.fail(F, id + " next", "next[" + i + "]=" + got + ", want " + w);
          nextOk = false;
          break;
        }
      }
      if (nextOk) r.check(F, id + " next", true, "");
      for (var e : obj(c.get("below")).entrySet()) {
        long n = Long.parseLong(e.getKey());
        Rng gb = Rng.fromSeed(seed);
        List<Object> seq = arr(e.getValue());
        boolean ok = true;
        for (int i = 0; i < seq.size(); i++) {
          long got = gb.below(n);
          long w = lng(seq.get(i));
          if (got != w) {
            r.fail(F, id + " below(" + e.getKey() + ")", "below[" + i + "]=" + got + ", want " + w);
            ok = false;
            break;
          }
        }
        if (ok) r.check(F, id + " below(" + e.getKey() + ")", true, "");
      }
    }
  }

  // ------------------------------------------------------------------ moves

  private static void checkMoves(Report r, Path dir) throws Exception {
    final String F = "moves.json";
    for (Object co : arr(load(dir, F).get("cases"))) {
      var c = obj(co);
      String bh = str(c.get("board"));
      byte[] b;
      try {
        b = Board.fromHex(bh);
      } catch (IllegalArgumentException e) {
        r.fail(F, bh, e.getMessage());
        continue;
      }
      for (Object ro : arr(c.get("results"))) {
        var res = obj(ro);
        String dirS = str(res.get("dir"));
        int d = Board.parseDirection(dirS);
        Board.MoveResult mr = Board.move(b, d);
        String nb = Board.hex(mr.board());
        boolean can = Board.canMove(b, d);
        String wb = str(res.get("board"));
        long wg = lng(res.get("gained"));
        boolean wc = bool(res.get("changed"));
        r.check(F, bh + " " + dirS, nb.equals(wb) && mr.gained() == wg && mr.changed() == wc && can == wc,
            "got board=" + nb + " gained=" + mr.gained() + " changed=" + mr.changed() + " canMove=" + can + ", want "
                + wb + " " + wg + " " + wc);
      }
      boolean over = Board.isOver(b);
      boolean wo = bool(c.get("over"));
      r.check(F, bh + " over", over == wo, "over=" + over + ", want " + wo);
    }
  }

  // ------------------------------------------------------------------ spawn

  private static void checkSpawn(Report r, Path dir) throws Exception {
    final String F = "spawn.json";
    List<Object> cases = arr(load(dir, F).get("cases"));
    for (int i = 0; i < cases.size(); i++) {
      var c = obj(cases.get(i));
      String bh = str(c.get("board"));
      byte[] b = Board.fromHex(bh);
      Rng g = new Rng(state(c.get("rngState")));
      Board.Spawned sp = Board.spawn(b, g);
      long[] after = ustate(state(c.get("rngStateAfter")));
      Object want = c.get("spawn");
      boolean good = Board.hex(b).equals(str(c.get("result"))) && Arrays.equals(g.state(), after)
          && sp.ok() == (want != null);
      if (good && sp.ok()) {
        var w = obj(want);
        good = sp.index() == lng(w.get("index")) && sp.exponent() == lng(w.get("exponent"));
      }
      r.check(F, "#" + i + " " + bh, good, "got " + Board.hex(b) + " idx=" + sp.index() + " exp=" + sp.exponent()
          + " ok=" + sp.ok() + " state=" + Arrays.toString(g.state()));
    }
  }

  // ------------------------------------------------------------------ hash

  private static void checkHash(Report r, Path dir) throws Exception {
    final String F = "hash.json";
    for (Object co : arr(load(dir, F).get("cases"))) {
      var c = obj(co);
      String bs = str(c.get("board"));
      byte[] b = Board.fromHex(bs);
      String bh = Hash.hex(Hash.boardHash(b));
      int prev = (int) Long.parseLong(str(c.get("prev")), 16);
      String hs = Hash.hex(Hash.historyStep(prev, b, (int) lng(c.get("dir"))));
      String wbh = str(c.get("boardHash")), whs = str(c.get("historyStep"));
      r.check(F, bs, bh.equals(wbh) && hs.equals(whs),
          "boardHash=" + bh + " historyStep=" + hs + ", want " + wbh + " " + whs);
    }
  }

  // ------------------------------------------------------------------ games

  private static boolean sameFinal(Game.Snapshot s, Map<String, Object> f) {
    return s.board().equals(str(f.get("board"))) && s.score() == lng(f.get("score"))
        && s.moveCount() == lng(f.get("moveCount")) && s.maxTile() == lng(f.get("maxTile"))
        && s.over() == bool(f.get("over")) && s.historyHash().equals(str(f.get("historyHash")));
  }

  private static void checkGames(Report r, Path dir) throws Exception {
    final String F = "games.json";
    var fx = load(dir, F);
    for (Object co : arr(fx.get("newGames"))) {
      var c = obj(co);
      long seed = lng(c.get("seed"));
      Game g = new Game((int) seed);
      r.check(F, "newGame seed=" + seed,
          Board.hex(g.board).equals(str(c.get("board"))) && Arrays.equals(g.rng.state(), ustate(state(c.get("rngState"))))
              && g.historyHash().equals(str(c.get("historyHash"))),
          "board=" + Board.hex(g.board) + " rng=" + g.rng + " hash=" + g.historyHash());
    }
    for (Object co : arr(fx.get("games"))) {
      var c = obj(co);
      long seed = lng(c.get("seed"));
      String agentName = str(c.get("agent"));
      String moves = str(c.get("moves"));
      var fin = obj(c.get("final"));
      String id = "game seed=" + seed + " agent=" + agentName;
      try {
        Game g = Replay.simulate((int) seed, moves);
        Game.Snapshot s = g.snapshot();
        r.check(F, id + " replay", sameFinal(s, fin), "final " + s + ", want " + fin);
      } catch (Replay.ReplayException e) {
        r.fail(F, id + " replay", e.getMessage());
      }
      Agents.Agent agent;
      switch (agentName) {
        case "random" -> agent = new Agents.RandomAgent();
        case "expectimax-d2" -> agent = Agents.create("expectimax", Map.of("depth", 2L));
        default -> {
          continue;
        }
      }
      // Random games run to completion; expectimax-d2 games were generated with maxMoves=1500,
      // so cap at the recorded length when not over.
      int limit = bool(fin.get("over")) ? 0 : moves.length();
      try {
        Bench.PlayResult pr = Bench.play(agent, (int) seed, limit, null);
        r.check(F, id + " agent", pr.game().moves().equals(moves) && sameFinal(pr.game().snapshot(), fin),
            "agent replay diverged (moves " + pr.game().moves().length() + " vs " + moves.length() + ")");
      } catch (RuntimeException e) {
        r.fail(F, id + " agent", String.valueOf(e.getMessage()));
      }
    }
  }

  // ------------------------------------------------------------------ replays

  private static void checkReplays(Report r, Path dir) throws Exception {
    final String F = "replays.json";
    for (Object co : arr(load(dir, F).get("cases"))) {
      var c = obj(co);
      String name = str(c.get("name"));
      int seed = u32(c.get("seed"));
      String moves = str(c.get("moves"));
      var expect = obj(c.get("expect"));
      Game.Snapshot snap = null;
      Replay.ReplayException err = null;
      try {
        snap = Replay.verify(1, seed, moves, null);
      } catch (Replay.ReplayException e) {
        err = e;
      }
      if (bool(expect.get("ok"))) {
        var fin = obj(expect.get("final"));
        boolean ok = err == null && sameFinal(snap, fin);
        r.check(F, name, ok, "err=" + (err == null ? "nil" : err.getMessage()) + " final=" + snap);
        if (ok) {
          var claim = new Replay.FinalClaim(str(fin.get("board")), lng(fin.get("score")), (int) lng(fin.get("moveCount")),
              str(fin.get("historyHash")));
          Replay.ReplayException e2 = null;
          try {
            Replay.verify(1, seed, moves, claim);
          } catch (Replay.ReplayException e) {
            e2 = e;
          }
          r.check(F, name + " claim", e2 == null, "valid claim rejected: " + (e2 == null ? "" : e2.getMessage()));
          e2 = null;
          try {
            Replay.verify(1, seed, moves, new Replay.FinalClaim(null, lng(fin.get("score")) + 4, null, null));
          } catch (Replay.ReplayException e) {
            e2 = e;
          }
          r.check(F, name + " bad-claim", e2 != null && e2.code.equals(Replay.FINAL_MISMATCH),
              "want FINAL_MISMATCH, got " + (e2 == null ? "nil" : e2.getMessage()));
          e2 = null;
          try {
            Replay.verify(2, seed, moves, null);
          } catch (Replay.ReplayException e) {
            e2 = e;
          }
          r.check(F, name + " spec-version", e2 != null && e2.code.equals(Replay.SPEC_VERSION),
              "want SPEC_VERSION, got " + (e2 == null ? "nil" : e2.getMessage()));
        }
        continue;
      }
      String wantErr = str(expect.get("error"));
      Object mi = expect.get("moveIndex");
      boolean ok = err != null && err.code.equals(wantErr);
      if (ok && mi != null) ok = err.moveIndex == lng(mi);
      r.check(F, name, ok, "got " + (err == null ? "nil" : err.getMessage()) + ", want " + wantErr + " at " + mi);
    }
  }

  // ------------------------------------------------------------------ codes

  private static void checkCodes(Report r, Path dir) throws Exception {
    final String F = "codes.json";
    var fx = load(dir, F);
    r.check(F, "alphabet", Ids.REPLAY_ALPHABET.equals(fx.get("alphabet")), "alphabet mismatch");
    for (Object co : arr(fx.get("cases"))) {
      var c = obj(co);
      String input = str(c.get("input"));
      String n = Ids.normalizeReplayCode(input);
      Object wn = c.get("normalized"), wf = c.get("formatted");
      boolean good;
      if (wn == null) good = n == null;
      else good = n != null && n.equals(wn) && wf != null && Ids.formatReplayCode(n).equals(wf);
      r.check(F, input, good, "normalized=\"" + (n == null ? "" : n) + "\" ok=" + (n != null));
    }
  }

  // ------------------------------------------------------------------ ai

  private static boolean relClose(double a, double b) {
    if (a == b) return true;
    return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  }

  private static Heuristic.LineFeatures featuresOf(Map<String, Object> m) {
    return new Heuristic.LineFeatures(lng(m.get("empty")), lng(m.get("merges")), lng(m.get("mono")),
        lng(m.get("sum")), lng(m.get("smooth")), lng(m.get("stable")));
  }

  private static void checkAI(Report r, Path dir) throws Exception {
    final String F = "ai.json";
    var fx = load(dir, F);
    var weights = obj(fx.get("weights"));
    Heuristic.Weights wc = Heuristic.Weights.fromMap(obj(weights.get("canonical")));
    Heuristic.Weights wa = Heuristic.Weights.fromMap(obj(weights.get("allWeights")));
    r.check(F, "canonical weights", wc.equals(Heuristic.HEURISTIC_V1), "canonical weights " + wc);
    double[] tc = Heuristic.lineTable(wc), ta = Heuristic.lineTable(wa);
    for (Object lo : arr(fx.get("lines"))) {
      var l = obj(lo);
      int line = (int) lng(l.get("line"));
      Heuristic.LineFeatures f = Heuristic.features(line);
      Heuristic.LineFeatures wf = featuresOf(obj(l.get("features")));
      double ec = dbl(l.get("canonical")), ea = dbl(l.get("allWeights"));
      r.check(F, "line " + line, f.equals(wf) && tc[line] == ec && ta[line] == ea,
          "features " + f + " canonical=" + tc[line] + " allWeights=" + ta[line] + ", want " + wf + " " + ec + " " + ea);
    }
    for (Object eo : arr(fx.get("evaluations"))) {
      var e = obj(eo);
      String bs = str(e.get("board"));
      long bb = Bitboard.fromBoard(Board.fromHex(bs));
      double vc = Heuristic.evaluate(bb, tc, wc.corner());
      double va = Heuristic.evaluate(bb, ta, wa.corner());
      double ec = dbl(e.get("canonical")), ea = dbl(e.get("allWeights"));
      r.check(F, "eval " + bs, vc == ec && va == ea,
          "canonical=" + vc + " allWeights=" + va + ", want " + ec + " " + ea);
    }
    for (Object mo : arr(fx.get("bitboardMoves"))) {
      var m = obj(mo);
      String bs = str(m.get("board"));
      long bb = Bitboard.fromBoard(Board.fromHex(bs));
      List<Object> results = arr(m.get("results"));
      for (int d = 0; d < results.size(); d++) {
        var res = obj(results.get(d));
        long nb = Bitboard.move(bb, d);
        boolean ch = nb != bb;
        String out = Board.hex(Bitboard.toBoard(nb));
        String wb = str(res.get("board"));
        boolean wch = bool(res.get("changed"));
        r.check(F, "bbmove " + bs + " " + Board.DIRECTION_LETTERS.charAt(d), out.equals(wb) && ch == wch,
            "got " + out + " " + ch + ", want " + wb + " " + wch);
      }
    }
    Map<String, Search> searchers = new HashMap<>();
    for (Object so : arr(fx.get("searches"))) {
      var s = obj(so);
      String bs = str(s.get("board"));
      String id = "search " + str(s.get("profile")) + " " + bs;
      String key = Json.write(s.get("config"));
      Search srch = searchers.get(key);
      if (srch == null) {
        Config c;
        try {
          c = Config.parse(obj(s.get("config")));
        } catch (IllegalArgumentException ex) {
          r.fail(F, id, "config: " + ex.getMessage());
          continue;
        }
        c.ttBits = 18;
        srch = new Search(c);
        searchers.put(key, srch);
      }
      Search.Result res = srch.run(Bitboard.fromBoard(Board.fromHex(bs)));
      String move = res.move() >= 0 ? String.valueOf(Board.DIRECTION_LETTERS.charAt(res.move())) : "null";
      String want = s.get("move") == null ? "null" : str(s.get("move"));
      long wantDepth = lng(s.get("depth"));
      List<Object> values = arr(s.get("values"));
      boolean ok = move.equals(want) && res.depth() == wantDepth && values.size() == 4;
      String msg = "move=" + move + " depth=" + res.depth() + ", want " + want + " " + wantDepth;
      for (int d = 0; ok && d < 4; d++) {
        Double got = res.values()[d];
        Object exp = values.get(d);
        if ((got == null) != (exp == null)) {
          ok = false;
          msg = "values[" + d + "] null mismatch";
        } else if (got != null) {
          aiTotal++;
          double e = dbl(exp);
          if (got == e) aiExact++;
          if (!relClose(got, e)) {
            ok = false;
            msg = "values[" + d + "]=" + got + ", want " + e;
          }
        }
      }
      r.check(F, id, ok, msg);
    }
  }

  // ------------------------------------------------------------------ benchmarks

  private static void checkBenchmarks(Report r, Path dir) throws Exception {
    final String F = "benchmarks.json";
    var suites = obj(load(dir, F).get("suites"));
    for (String id : new TreeSet<>(suites.keySet())) {
      var want = obj(suites.get(id));
      Suite suite;
      try {
        suite = Suite.load(dir.resolve("..").resolve("benchmarks").resolve(id + ".json"));
      } catch (Exception e) {
        r.fail(F, id, String.valueOf(e.getMessage()));
        continue;
      }
      if (suite.hasTag("heavy")) continue;
      Bench.Result res;
      try {
        res = Bench.run(suite, null);
      } catch (RuntimeException e) {
        r.fail(F, id, String.valueOf(e.getMessage()));
        continue;
      }
      long total = 0;
      for (var g : res.games()) total += g.score();
      var s = res.summary();
      r.check(F, id, res.checksum().equals(want.get("checksum")) && s.games() == lng(want.get("games"))
              && s.totalMoves() == lng(want.get("totalMoves")) && total == lng(want.get("totalScore"))
              && s.maxScore() == lng(want.get("maxScore")),
          "checksum=" + res.checksum() + " games=" + s.games() + " totalMoves=" + s.totalMoves() + " totalScore="
              + total + " maxScore=" + s.maxScore() + ", want " + Json.write(want));
    }
  }
}
