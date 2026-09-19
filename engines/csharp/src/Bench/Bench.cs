using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using G2048.Ai;
using G2048.Cli;
using G2048.Engine;

namespace G2048.Bench;

/// <summary>A benchmark suite definition (spec/benchmarks/*.json).</summary>
public sealed record Suite(
    string Id,
    string Name,
    int SpecVersion,
    string AgentId,
    JsonObject? AgentConfig,
    uint SeedStart,
    int SeedCount,
    int MaxMoves,
    bool TimeDecisions,
    string[] Tags)
{
    public bool HasTag(string t) => Tags.Contains(t);

    public static Suite Load(string path)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(File.ReadAllText(path));
        }
        catch (JsonException e)
        {
            throw new InvalidDataException($"{path}: {e.Message}");
        }
        if (root is not JsonObject o) throw new InvalidDataException($"{path}: suite must be an object");
        var agent = o["agent"] as JsonObject;
        var seeds = o["seeds"] as JsonObject;
        var cfg = agent?["config"];
        return new Suite(
            (string?)o["id"] ?? "",
            (string?)o["name"] ?? "",
            (int?)o["specVersion"] ?? 0,
            (string?)agent?["id"] ?? "",
            cfg as JsonObject,
            (uint?)seeds?["start"] ?? 0,
            (int?)seeds?["count"] ?? 0,
            (int?)o["maxMoves"] ?? 0,
            (bool?)o["timeDecisions"] ?? false,
            (o["tags"] as JsonArray)?.Select(t => (string?)t ?? "").ToArray() ?? []);
    }
}

/// <summary>One game's outcome.</summary>
public sealed record GameResult(uint Seed, long Score, long MaxTile, int MoveCount, bool Over, string HistoryHash, double WallMs, long Nodes)
{
    public JObj ToJson() => new()
    {
        { "seed", Seed }, { "score", Score }, { "maxTile", MaxTile }, { "moveCount", MoveCount },
        { "over", Over }, { "historyHash", HistoryHash }, { "wallMs", WallMs }, { "nodes", Nodes },
    };
}

/// <summary>Aggregate statistics (definitions match the TS sim.ts).</summary>
public sealed class Summary
{
    public int Games;
    public double AvgScore, MedianScore;
    public long MinScore, MaxScore, MaxTile, TotalMoves;
    public double WallMs;
    public double? CpuMs;
    public double GamesPerSec, MovesPerSec, DecisionsPerSec;
    public long Nodes;
    public double NodesPerSec;
    public long? PeakMemoryBytes;
    public double? AvgDecisionUs, P50DecisionUs, P99DecisionUs;
    public SortedDictionary<long, int> TileDistribution = [];
    public SortedDictionary<long, double> ReachRates = [];

    public JObj ToJson()
    {
        var td = new JObj();
        foreach (var (k, v) in TileDistribution) td.Add(k.ToString(), v);
        var rr = new JObj();
        foreach (var (k, v) in ReachRates) rr.Add(k.ToString(), v);
        return new JObj
        {
            { "games", Games }, { "avgScore", AvgScore }, { "medianScore", MedianScore },
            { "minScore", MinScore }, { "maxScore", MaxScore }, { "maxTile", MaxTile },
            { "totalMoves", TotalMoves }, { "wallMs", WallMs }, { "cpuMs", CpuMs },
            { "gamesPerSec", GamesPerSec }, { "movesPerSec", MovesPerSec }, { "decisionsPerSec", DecisionsPerSec },
            { "nodes", Nodes }, { "nodesPerSec", NodesPerSec }, { "peakMemoryBytes", PeakMemoryBytes },
            { "avgDecisionUs", AvgDecisionUs }, { "p50DecisionUs", P50DecisionUs }, { "p99DecisionUs", P99DecisionUs },
            { "tileDistribution", td }, { "reachRates", rr },
        };
    }
}

/// <summary>A BenchmarkResult (spec/schemas/benchmark-result.schema.json).</summary>
public sealed class Result
{
    public required string SuiteId;
    public required JObj Implementation;
    public required JObj Environment;
    public required string AgentId;
    public JsonObject? AgentConfig;
    public bool Deterministic;
    public required string StartedAt, FinishedAt;
    public required List<GameResult> Games;
    public required Summary Summary;
    public required string Checksum;

    public JObj ToJson()
    {
        var agent = new JObj { { "id", AgentId } };
        if (AgentConfig is not null) agent.Add("config", AgentConfig);
        return new JObj
        {
            { "schemaVersion", 1 }, { "suiteId", SuiteId }, { "specVersion", Game.SpecVersion },
            { "implementation", Implementation }, { "environment", Environment }, { "agent", agent },
            { "deterministic", Deterministic }, { "startedAt", StartedAt }, { "finishedAt", FinishedAt },
            { "games", Games.Select(g => g.ToJson()).ToList() }, { "summary", Summary.ToJson() },
            { "checksum", Checksum },
        };
    }
}

/// <summary>Outcome of <see cref="Runner.Play"/>.</summary>
public sealed record PlayResult(Game Game, long Nodes, double WallMs);

public static class Runner
{
    /// <summary>reachRates keys.</summary>
    public static readonly long[] ReachTiles = [2048, 4096, 8192, 16384, 32768, 65536];

    /// <summary>Runs an agent on seed until the game ends or maxMoves (0 = unlimited).</summary>
    public static PlayResult Play(IAgent agent, uint seed, int maxMoves, Action<long>? onDecision)
    {
        long t0 = Stopwatch.GetTimestamp();
        var g = new Game(seed);
        agent.Reset(g.Seed);
        long nodes = 0;
        while ((maxMoves <= 0 || g.MoveCount < maxMoves) && !g.Over)
        {
            var d = agent.Decide(g.Board);
            if (d.Move < 0) throw new InvalidOperationException($"agent {agent.Id} returned no move at {g.MoveCount}");
            if (!g.Apply(d.Move)) throw new InvalidOperationException($"agent {agent.Id} returned invalid move {d.Move} at {g.MoveCount}");
            if (d.Metrics.Nodes is long n) nodes += n;
            onDecision?.Invoke(d.Metrics.TimeUs);
        }
        return new PlayResult(g, nodes, Timing.ElapsedMs(t0));
    }

    private static double Percentile(double[] sorted, double p) =>
        sorted.Length == 0 ? 0 : sorted[Math.Min(sorted.Length - 1, (int)Math.Floor(p * sorted.Length))];

    public static Summary Summarise(List<GameResult> games, double wallMs, double? cpuMs, long? peak, List<double>? decisions)
    {
        var s = new Summary { Games = games.Count, WallMs = wallMs, CpuMs = cpuMs, PeakMemoryBytes = peak };
        var scores = new long[games.Count];
        long total = 0;
        for (int i = 0; i < games.Count; i++)
        {
            var g = games[i];
            scores[i] = g.Score;
            total += g.Score;
            s.TotalMoves += g.MoveCount;
            s.Nodes += g.Nodes;
            s.MaxTile = Math.Max(s.MaxTile, g.MaxTile);
            s.TileDistribution[g.MaxTile] = s.TileDistribution.GetValueOrDefault(g.MaxTile) + 1;
        }
        Array.Sort(scores);
        int n = games.Count;
        if (n > 0)
        {
            s.AvgScore = (double)total / n;
            s.MedianScore = scores[n / 2];
            s.MinScore = scores[0];
            s.MaxScore = scores[n - 1];
        }
        foreach (long t in ReachTiles)
            s.ReachRates[t] = n > 0 ? (double)games.Count(g => g.MaxTile >= t) / n : 0.0;
        double secs = wallMs / 1000;
        if (secs > 0)
        {
            s.GamesPerSec = n / secs;
            s.MovesPerSec = s.TotalMoves / secs;
            s.DecisionsPerSec = s.MovesPerSec;
            s.NodesPerSec = s.Nodes / secs;
        }
        if (decisions is { Count: > 0 })
        {
            var sorted = decisions.ToArray();
            Array.Sort(sorted);
            double sum = 0;
            foreach (double x in sorted) sum += x;
            s.AvgDecisionUs = sum / sorted.Length;
            s.P50DecisionUs = Percentile(sorted, 0.5);
            s.P99DecisionUs = Percentile(sorted, 0.99);
        }
        return s;
    }

    /// <summary>fnv1a32 over the concatenated historyHash strings.</summary>
    public static string Checksum(IEnumerable<GameResult> games) =>
        Hash.Hex(Hash.Fnv1a32(Encoding.ASCII.GetBytes(string.Concat(games.Select(g => g.HistoryHash)))));

    public static string Platform() =>
        OperatingSystem.IsLinux() ? "linux"
        : OperatingSystem.IsMacOS() ? "darwin"
        : OperatingSystem.IsWindows() ? "win32"
        : OperatingSystem.IsFreeBSD() ? "freebsd"
        : RuntimeInformation.OSDescription.ToLowerInvariant();

    public static JObj ImplementationInfo() => new()
    {
        { "language", "csharp" },
        { "runtime", "dotnet" },
        { "runtimeVersion", System.Environment.Version.ToString() },
        { "engineVersion", Game.EngineVersion },
        { "platform", Platform() },
    };

    /// <summary>Host facts (keys sorted, like Go's map encoding).</summary>
    public static JObj EnvironmentInfo()
    {
        var env = new SortedDictionary<string, object>(StringComparer.Ordinal)
        {
            ["os"] = Platform(),
            ["arch"] = RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant(),
            ["cpus"] = System.Environment.ProcessorCount,
        };
        try
        {
            foreach (string line in File.ReadLines("/proc/cpuinfo"))
            {
                int i = line.IndexOf(':');
                if (i > 0 && line[..i].Trim() == "model name")
                {
                    env["cpu"] = line[(i + 1)..].Trim();
                    break;
                }
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        try
        {
            foreach (string line in File.ReadLines("/proc/meminfo"))
            {
                if (!line.StartsWith("MemTotal:", StringComparison.Ordinal)) continue;
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 2 && long.TryParse(parts[1], out long kb)) env["memoryBytes"] = kb * 1024;
                break;
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        var o = new JObj();
        foreach (var (k, v) in env) o.Add(k, v);
        return o;
    }

    private static string IsoNow() => DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    private static double CpuMs() => Process.GetCurrentProcess().TotalProcessorTime.TotalMilliseconds;

    private static long? PeakMemory()
    {
        try
        {
            using var p = Process.GetCurrentProcess();
            long v = p.PeakWorkingSet64;
            return v > 0 ? v : null;
        }
        catch (Exception) { return null; }
    }

    /// <summary>Executes a suite. Progress lines go to progress (may be null).</summary>
    public static Result Run(Suite suite, TextWriter? progress)
    {
        if (suite.SpecVersion != Game.SpecVersion)
            throw new InvalidOperationException($"suite {suite.Id} targets spec v{suite.SpecVersion}");
        var agent = Agents.Create(suite.AgentId, suite.AgentConfig);
        string startedAt = IsoNow();
        double cpu0 = CpuMs();
        long t0 = Stopwatch.GetTimestamp();
        List<double>? decisions = suite.TimeDecisions ? new List<double>(1024) : null;
        Action<long>? onDecision = decisions is null ? null : us => decisions.Add(us);
        var games = new List<GameResult>(suite.SeedCount);
        for (int i = 0; i < suite.SeedCount; i++)
        {
            uint seed = unchecked(suite.SeedStart + (uint)i);
            var pr = Play(agent, seed, suite.MaxMoves, onDecision);
            var g = pr.Game;
            var r = new GameResult(seed, g.Score, 1L << Board.MaxExponent(g.Board), g.MoveCount, g.Over, g.HistoryHash, pr.WallMs, pr.Nodes);
            games.Add(r);
            if (progress is not null && (suite.SeedCount <= 100 || (i + 1) % 100 == 0 || i + 1 == suite.SeedCount))
            {
                progress.WriteLine(
                    $"[{suite.Id}] game {i + 1}/{suite.SeedCount} seed={seed} score={r.Score} maxTile={r.MaxTile} moves={r.MoveCount} {r.WallMs:F0}ms");
            }
        }
        double wallMs = Timing.ElapsedMs(t0);
        double cpu = CpuMs() - cpu0;
        return new Result
        {
            SuiteId = suite.Id,
            Implementation = ImplementationInfo(),
            Environment = EnvironmentInfo(),
            AgentId = suite.AgentId,
            AgentConfig = suite.AgentConfig,
            Deterministic = agent.Deterministic,
            StartedAt = startedAt,
            FinishedAt = IsoNow(),
            Games = games,
            Summary = Summarise(games, wallMs, cpu, PeakMemory(), decisions),
            Checksum = Checksum(games),
        };
    }
}
