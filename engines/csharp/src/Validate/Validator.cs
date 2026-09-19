using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using G2048.Ai;
using G2048.Bench;
using G2048.Cli;
using G2048.Engine;

namespace G2048.Validate;

/// <summary>One failed fixture case.</summary>
public sealed record Failure(string Fixture, string Case, string Message);

/// <summary>Accumulated validation results.</summary>
public sealed class Report
{
    public int Passed { get; private set; }
    public int Failed { get; private set; }
    public List<Failure> Failures { get; } = [];

    /// <summary>Passed/failed counts by fixture file.</summary>
    public Dictionary<string, (int Passed, int Failed)> PerFixture { get; } = [];

    public bool Check(string fixture, string name, bool ok, Func<string> message)
    {
        var pf = PerFixture.GetValueOrDefault(fixture);
        if (ok)
        {
            Passed++;
            pf.Passed++;
        }
        else
        {
            Failed++;
            pf.Failed++;
            Failures.Add(new Failure(fixture, name, message()));
        }
        PerFixture[fixture] = pf;
        return ok;
    }

    public bool Check(string fixture, string name, bool ok, string message) => Check(fixture, name, ok, () => message);

    public void Fail(string fixture, string name, string message) => Check(fixture, name, false, message);

    public JObj ToJson() => new()
    {
        { "language", "csharp" },
        { "engineVersion", Game.EngineVersion },
        { "passed", Passed },
        { "failed", Failed },
        { "failures", Failures.Select(f => new JObj { { "fixture", f.Fixture }, { "case", f.Case }, { "message", f.Message } }).ToList() },
    };
}

/// <summary>Checks this port against the cross-language fixtures in spec/fixtures.</summary>
public static class Validator
{
    /// <summary>Fixture files in check order (benchmarks-heavy.json is not run, like the Go port).</summary>
    public static readonly string[] Fixtures =
        ["rng.json", "moves.json", "spawn.json", "hash.json", "games.json", "replays.json", "codes.json", "ai.json", "benchmarks.json"];

    public static Report All(string dir, bool skipBenchmarks)
    {
        var r = new Report();
        foreach (string f in Fixtures)
        {
            if (f == "benchmarks.json" && skipBenchmarks) continue;
            Run(r, dir, f);
        }
        return r;
    }

    public static void Run(Report r, string dir, string name)
    {
        try
        {
            switch (name)
            {
                case "rng.json": CheckRng(r, dir); break;
                case "moves.json": CheckMoves(r, dir); break;
                case "spawn.json": CheckSpawn(r, dir); break;
                case "hash.json": CheckHash(r, dir); break;
                case "games.json": CheckGames(r, dir); break;
                case "replays.json": CheckReplays(r, dir); break;
                case "codes.json": CheckCodes(r, dir); break;
                case "ai.json": CheckAi(r, dir); break;
                case "benchmarks.json": CheckBenchmarks(r, dir); break;
                default: throw new InvalidDataException("unknown fixture");
            }
        }
        catch (Exception e) when (e is IOException or JsonException or InvalidDataException or FormatException
                                      or InvalidOperationException or ArgumentException or UnauthorizedAccessException)
        {
            r.Fail(name, "load", e.Message);
        }
    }

    // ---- JSON helpers ----------------------------------------------------

    private static JsonObject Load(string dir, string name) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(dir, name))) as JsonObject
        ?? throw new InvalidDataException($"{name}: expected an object");

    private static JsonArray Arr(JsonNode? n) => n as JsonArray ?? [];

    private static string Str(JsonNode? n) => n is null ? "" : n.GetValue<string>();

    private static uint U32(JsonNode? n) => n!.GetValue<uint>();

    private static long I64(JsonNode? n) => n!.GetValue<long>();

    private static int I32(JsonNode? n) => n!.GetValue<int>();

    private static bool Bool(JsonNode? n) => n is not null && n.GetValue<bool>();

    private static double F64(JsonNode? n) => n!.GetValue<double>();

    private static uint[] State(JsonNode? n) => Arr(n).Select(U32).ToArray();

    private static string Fmt(uint[] s) => "[" + string.Join(" ", s) + "]";

    private static string Fmt(double v) => Json.FormatFloat(v);

    // ---- checks ------------------------------------------------------------

    private static void CheckRng(Report r, string dir)
    {
        const string F = "rng.json";
        foreach (var c in Arr(Load(dir, F)["cases"]))
        {
            uint seed = U32(c!["seed"]);
            string id = $"seed={seed}";
            var st = Rng.Mix32(seed);
            var want = State(c["state"]);
            r.Check(F, id + " state", st.SequenceEqual(want), () => $"state {Fmt(st)}, want {Fmt(want)}");
            var g = new Rng(st);
            bool ok = true;
            int i = 0;
            foreach (var w in Arr(c["next"]))
            {
                uint got = g.Next(), exp = U32(w);
                if (got != exp)
                {
                    r.Fail(F, id + " next", $"next[{i}]={got}, want {exp}");
                    ok = false;
                    break;
                }
                i++;
            }
            if (ok) r.Check(F, id + " next", true, "");
            if (c["below"] is JsonObject below)
            {
                foreach (var (ns, seq) in below)
                {
                    ulong n = ulong.Parse(ns);
                    var gb = Rng.FromSeed(seed);
                    bool bok = true;
                    int j = 0;
                    foreach (var w in Arr(seq))
                    {
                        uint got = gb.Below(n), exp = U32(w);
                        if (got != exp)
                        {
                            r.Fail(F, $"{id} below({ns})", $"below[{j}]={got}, want {exp}");
                            bok = false;
                            break;
                        }
                        j++;
                    }
                    if (bok) r.Check(F, $"{id} below({ns})", true, "");
                }
            }
        }
    }

    private static void CheckMoves(Report r, string dir)
    {
        const string F = "moves.json";
        foreach (var c in Arr(Load(dir, F)["cases"]))
        {
            string hex = Str(c!["board"]);
            if (!Board.TryFromHex(hex, out var b, out string err))
            {
                r.Fail(F, hex, err);
                continue;
            }
            foreach (var res in Arr(c["results"]))
            {
                string dirName = Str(res!["dir"]);
                int d = Board.ParseDirection(dirName);
                var (nb, g, ch) = Board.Move(b, d);
                bool can = Board.CanMove(b, d);
                string wb = Str(res["board"]);
                long wg = I64(res["gained"]);
                bool wc = Bool(res["changed"]);
                r.Check(F, hex + " " + dirName, Board.Hex(nb) == wb && g == wg && ch == wc && can == wc,
                    () => $"got board={Board.Hex(nb)} gained={g} changed={ch} canMove={can}, want {wb} {wg} {wc}");
            }
            bool over = Bool(c["over"]);
            r.Check(F, hex + " over", Board.IsOver(b) == over, () => $"over={Board.IsOver(b)}, want {over}");
        }
    }

    private static void CheckSpawn(Report r, string dir)
    {
        const string F = "spawn.json";
        int i = 0;
        foreach (var c in Arr(Load(dir, F)["cases"]))
        {
            string hex = Str(c!["board"]);
            var b = Board.FromHex(hex);
            var g = new Rng(State(c["rngState"]));
            bool ok = Board.Spawn(b, g, out int idx, out byte e);
            var spawn = c["spawn"] as JsonObject;
            bool good = Board.Hex(b) == Str(c["result"]) && g.State().SequenceEqual(State(c["rngStateAfter"])) && ok == (spawn is not null);
            if (good && ok) good = idx == I32(spawn!["index"]) && e == I32(spawn["exponent"]);
            r.Check(F, $"#{i} {hex}", good, () => $"got {Board.Hex(b)} idx={idx} exp={e} ok={ok} state={Fmt(g.State())}");
            i++;
        }
    }

    private static void CheckHash(Report r, string dir)
    {
        const string F = "hash.json";
        foreach (var c in Arr(Load(dir, F)["cases"]))
        {
            string hex = Str(c!["board"]);
            var b = Board.FromHex(hex);
            string bh = Hash.Hex(Hash.BoardHash(b));
            uint prev = Convert.ToUInt32(Str(c["prev"]), 16);
            string hs = Hash.Hex(Hash.HistoryStep(prev, b, I32(c["dir"])));
            string wbh = Str(c["boardHash"]), whs = Str(c["historyStep"]);
            r.Check(F, hex, bh == wbh && hs == whs, () => $"boardHash={bh} historyStep={hs}, want {wbh} {whs}");
        }
    }

    private static bool SameFinal(Snapshot s, JsonNode? f) =>
        f is not null && s.Board == Str(f["board"]) && s.Score == I64(f["score"]) && s.MoveCount == I32(f["moveCount"])
        && s.MaxTile == I64(f["maxTile"]) && s.Over == Bool(f["over"]) && s.HistoryHash == Str(f["historyHash"]);

    private static void CheckGames(Report r, string dir)
    {
        const string F = "games.json";
        var fx = Load(dir, F);
        foreach (var c in Arr(fx["newGames"]))
        {
            uint seed = U32(c!["seed"]);
            var g = new Game(seed);
            r.Check(F, $"newGame seed={seed}",
                Board.Hex(g.Board) == Str(c["board"]) && g.Rng.State().SequenceEqual(State(c["rngState"])) && g.HistoryHash == Str(c["historyHash"]),
                () => $"board={Board.Hex(g.Board)} rng={Fmt(g.Rng.State())} hash={g.HistoryHash}");
        }
        foreach (var c in Arr(fx["games"]))
        {
            uint seed = U32(c!["seed"]);
            string agentName = Str(c["agent"]);
            string moves = Str(c["moves"]);
            var final = c["final"];
            string id = $"game seed={seed} agent={agentName}";
            try
            {
                var s = Replay.Simulate(seed, moves).Snapshot();
                r.Check(F, id + " replay", SameFinal(s, final), () => $"final {s}, want {final?.ToJsonString()}");
            }
            catch (ReplayException e)
            {
                r.Fail(F, id + " replay", e.Message);
            }
            IAgent agent;
            switch (agentName)
            {
                case "random": agent = new RandomAgent(); break;
                case "expectimax-d2": agent = Agents.Create("expectimax", new JsonObject { ["depth"] = 2 }); break;
                default: continue;
            }
            // Random games run to completion; expectimax-d2 games were generated
            // with maxMoves=1500, so cap at the recorded length when not over.
            int limit = Bool(final?["over"]) ? 0 : moves.Length;
            PlayResult pr;
            try
            {
                pr = Runner.Play(agent, seed, limit, null);
            }
            catch (InvalidOperationException e)
            {
                r.Fail(F, id + " agent", e.Message);
                continue;
            }
            r.Check(F, id + " agent", pr.Game.Moves == moves && SameFinal(pr.Game.Snapshot(), final),
                () => $"agent replay diverged (moves {pr.Game.Moves.Length} vs {moves.Length})");
        }
    }

    private static void CheckReplays(Report r, string dir)
    {
        const string F = "replays.json";
        foreach (var c in Arr(Load(dir, F)["cases"]))
        {
            string name = Str(c!["name"]);
            uint seed = U32(c["seed"]);
            string moves = Str(c["moves"]);
            var expect = c["expect"]!;
            Snapshot? snap = null;
            ReplayException? err = null;
            try { snap = Replay.Verify(1, seed, moves, null); }
            catch (ReplayException e) { err = e; }
            if (Bool(expect["ok"]))
            {
                var f = expect["final"];
                bool ok = err is null && SameFinal(snap!, f);
                r.Check(F, name, ok, () => $"err={err?.Message} final={snap}");
                if (!ok) continue;
                // a correct claim verifies, a wrong claim is rejected, a wrong spec version is rejected
                var claim = new FinalClaim(Str(f!["board"]), I64(f["score"]), I32(f["moveCount"]), Str(f["historyHash"]));
                ReplayException? e1 = Try(() => Replay.Verify(1, seed, moves, claim));
                r.Check(F, name + " claim", e1 is null, () => $"valid claim rejected: {e1?.Message}");
                ReplayException? e2 = Try(() => Replay.Verify(1, seed, moves, new FinalClaim(Score: I64(f["score"]) + 4)));
                r.Check(F, name + " bad-claim", e2?.Code == ReplayException.FinalMismatch, () => $"want FINAL_MISMATCH, got {e2?.Message}");
                ReplayException? e3 = Try(() => Replay.Verify(2, seed, moves, null));
                r.Check(F, name + " spec-version", e3?.Code == ReplayException.SpecVersionError, () => $"want SPEC_VERSION, got {e3?.Message}");
                continue;
            }
            string wantCode = Str(expect["error"]);
            bool good = err is not null && err.Code == wantCode;
            var mi = expect["moveIndex"];
            if (good && mi is not null) good = err!.MoveIndex == I32(mi);
            r.Check(F, name, good, () => $"got {err?.Message}, want {wantCode} at {mi?.ToJsonString() ?? "<nil>"}");
        }
    }

    private static ReplayException? Try(Action a)
    {
        try
        {
            a();
            return null;
        }
        catch (ReplayException e)
        {
            return e;
        }
    }

    private static void CheckCodes(Report r, string dir)
    {
        const string F = "codes.json";
        var fx = Load(dir, F);
        r.Check(F, "alphabet", Str(fx["alphabet"]) == Ids.ReplayAlphabet, "alphabet mismatch");
        foreach (var c in Arr(fx["cases"]))
        {
            string input = Str(c!["input"]);
            string? n = Ids.NormalizeReplayCode(input);
            var wantN = c["normalized"];
            var wantF = c["formatted"];
            bool good = wantN is null
                ? n is null
                : n is not null && n == Str(wantN) && wantF is not null && Ids.FormatReplayCode(n) == Str(wantF);
            r.Check(F, input, good, () => $"normalized=\"{n}\" ok={n is not null}");
        }
    }

    private static Weights ParseWeights(JsonNode? n) => new(
        I64(n!["lost"]), I64(n["empty"]), I64(n["merges"]), I64(n["mono"]),
        I64(n["sum"]), I64(n["smooth"]), I64(n["stable"]), I64(n["corner"]));

    private static bool RelClose(double a, double b) =>
        a == b || Math.Abs(a - b) <= 1e-9 * Math.Max(Math.Abs(a), Math.Abs(b));

    /// <summary>Search values that were bit-identical to the fixture (informational).</summary>
    public static int AiExact, AiTotal;

    private static void CheckAi(Report r, string dir)
    {
        const string F = "ai.json";
        var fx = Load(dir, F);
        var wc = ParseWeights(fx["weights"]?["canonical"]);
        var wa = ParseWeights(fx["weights"]?["allWeights"]);
        r.Check(F, "canonical weights", wc == Weights.V1, () => $"canonical weights {wc}");
        double[] tc = Heuristic.LineTable(wc), ta = Heuristic.LineTable(wa);
        foreach (var l in Arr(fx["lines"]))
        {
            ushort line = (ushort)I32(l!["line"]);
            var f = Heuristic.Features(line);
            var fw = l["features"]!;
            var want = new LineFeatures(I64(fw["empty"]), I64(fw["merges"]), I64(fw["mono"]), I64(fw["sum"]), I64(fw["smooth"]), I64(fw["stable"]));
            double ec = F64(l["canonical"]), ea = F64(l["allWeights"]);
            r.Check(F, $"line {line}", f == want && tc[line] == ec && ta[line] == ea,
                () => $"features {f} canonical={Fmt(tc[line])} allWeights={Fmt(ta[line])}, want {want} {Fmt(ec)} {Fmt(ea)}");
        }
        foreach (var e in Arr(fx["evaluations"]))
        {
            string hex = Str(e!["board"]);
            ulong bb = Bitboard.FromBoard(Board.FromHex(hex));
            double vc = Heuristic.Evaluate(bb, tc, wc.Corner), va = Heuristic.Evaluate(bb, ta, wa.Corner);
            double ec = F64(e["canonical"]), ea = F64(e["allWeights"]);
            r.Check(F, "eval " + hex, vc == ec && va == ea, () => $"canonical={Fmt(vc)} allWeights={Fmt(va)}, want {Fmt(ec)} {Fmt(ea)}");
        }
        foreach (var m in Arr(fx["bitboardMoves"]))
        {
            string hex = Str(m!["board"]);
            ulong bb = Bitboard.FromBoard(Board.FromHex(hex));
            int d = 0;
            foreach (var res in Arr(m["results"]))
            {
                ulong nb = Bitboard.Move(bb, d);
                bool ch = nb != bb;
                string outHex = Board.Hex(Bitboard.ToBoard(nb));
                string wb = Str(res!["board"]);
                bool wch = Bool(res["changed"]);
                r.Check(F, $"bbmove {hex} {Board.DirectionLetters[d]}", outHex == wb && ch == wch, () => $"got {outHex} {ch}, want {wb} {wch}");
                d++;
            }
        }
        var searchers = new Dictionary<string, Search>();
        foreach (var s in Arr(fx["searches"]))
        {
            string hex = Str(s!["board"]);
            string id = $"search {Str(s["profile"])} {hex}";
            var cfgNode = s["config"];
            string key = cfgNode?.ToJsonString() ?? "null";
            if (!searchers.TryGetValue(key, out var srch))
            {
                Config c;
                try
                {
                    c = Config.Parse(cfgNode as JsonObject);
                }
                catch (ArgumentException ex)
                {
                    r.Fail(F, id, "config: " + ex.Message);
                    continue;
                }
                c.TTBits = 18;
                srch = new Search(c);
                searchers[key] = srch;
            }
            var res = srch.Run(Bitboard.FromBoard(Board.FromHex(hex)));
            string move = res.Move >= 0 ? Board.DirectionLetters[res.Move].ToString() : "null";
            string want = s["move"] is JsonNode mv ? Str(mv) : "null";
            int wantDepth = I32(s["depth"]);
            var values = Arr(s["values"]);
            bool ok = move == want && res.Depth == wantDepth && values.Count == 4;
            string msg = $"move={move} depth={res.Depth}, want {want} {wantDepth}";
            for (int d = 0; ok && d < 4; d++)
            {
                double? got = res.Values[d];
                double? exp = values[d] is JsonNode vn ? F64(vn) : null;
                if (got.HasValue != exp.HasValue)
                {
                    ok = false;
                    msg = $"values[{d}] null mismatch";
                }
                else if (got is double gv && exp is double ev)
                {
                    AiTotal++;
                    if (gv == ev) AiExact++;
                    if (!RelClose(gv, ev))
                    {
                        ok = false;
                        msg = $"values[{d}]={Fmt(gv)}, want {Fmt(ev)}";
                    }
                }
            }
            r.Check(F, id, ok, msg);
        }
    }

    private static void CheckBenchmarks(Report r, string dir)
    {
        const string F = "benchmarks.json";
        var fx = Load(dir, F);
        var suites = fx["suites"] as JsonObject ?? [];
        foreach (var (id, want) in suites.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            Suite suite;
            try
            {
                suite = Suite.Load(Path.Combine(dir, "..", "benchmarks", id + ".json"));
            }
            catch (Exception e) when (e is IOException or InvalidDataException or UnauthorizedAccessException)
            {
                r.Fail(F, id, e.Message);
                continue;
            }
            if (suite.HasTag("heavy")) continue;
            Result res;
            try
            {
                res = Runner.Run(suite, null);
            }
            catch (Exception e) when (e is InvalidOperationException or ArgumentException)
            {
                r.Fail(F, id, e.Message);
                continue;
            }
            long total = res.Games.Sum(g => g.Score);
            var s = res.Summary;
            string wc = Str(want!["checksum"]);
            int wg = I32(want["games"]);
            long wm = I64(want["totalMoves"]), wt = I64(want["totalScore"]), wx = I64(want["maxScore"]);
            r.Check(F, id, res.Checksum == wc && s.Games == wg && s.TotalMoves == wm && total == wt && s.MaxScore == wx,
                () => $"checksum={res.Checksum} games={s.Games} totalMoves={s.TotalMoves} totalScore={total} maxScore={s.MaxScore}, want {want.ToJsonString()}");
        }
    }
}
