using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json.Nodes;
using G2048.Ai;
using G2048.Bench;
using G2048.Engine;
using G2048.Validate;

namespace G2048.Cli;

/// <summary>Minimal Go-flag-style parser: -name, --name, --name=value, --name value.</summary>
internal sealed class Flags(string command, IEnumerable<string> boolFlags, IEnumerable<string> valueFlags)
{
    private readonly HashSet<string> _bools = [.. boolFlags];
    private readonly HashSet<string> _values = [.. valueFlags];
    private readonly Dictionary<string, string> _set = [];

    public List<string> Rest { get; } = [];

    public Flags Parse(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--")
            {
                Rest.AddRange(args[(i + 1)..]);
                break;
            }
            if (!a.StartsWith('-') || a == "-")
            {
                Rest.AddRange(args[i..]);
                break;
            }
            string name = a.TrimStart('-');
            string? value = null;
            int eq = name.IndexOf('=');
            if (eq >= 0)
            {
                value = name[(eq + 1)..];
                name = name[..eq];
            }
            if (name is "h" or "help") throw new UsageException("");
            if (_bools.Contains(name))
            {
                _set[name] = value ?? "true";
            }
            else if (_values.Contains(name))
            {
                if (value is null)
                {
                    if (i + 1 >= args.Length) throw new UsageException($"flag needs an argument: -{name}");
                    value = args[++i];
                }
                _set[name] = value;
            }
            else
            {
                throw new UsageException($"flag provided but not defined: -{name}");
            }
        }
        return this;
    }

    public string? Get(string name) => _set.GetValueOrDefault(name);

    public string Get(string name, string def) => _set.GetValueOrDefault(name) ?? def;

    public bool Bool(string name)
    {
        string? v = Get(name);
        if (v is null) return false;
        return v switch
        {
            "1" or "t" or "T" or "true" or "TRUE" or "True" => true,
            "0" or "f" or "F" or "false" or "FALSE" or "False" => false,
            _ => throw new UsageException($"invalid boolean value \"{v}\" for -{name} ({command})"),
        };
    }
}

internal sealed class UsageException(string message) : Exception(message);

public static class Program
{
    private const string Usage = """
        usage: g2048 <command> [flags]

        commands:
          validate [--fixtures DIR] [--json] [--skip-bench]   run every spec fixture check
          bench --suite FILE [--out FILE]                      run a benchmark suite, emit BenchmarkResult JSON
          play --seed N [--agent expectimax|random|greedy] [--depth auto|N] [--max-moves N]

        """;

    public static int Main(string[] args)
    {
        Console.Out.NewLine = "\n";
        Console.Error.NewLine = "\n";
        if (args.Length < 1)
        {
            Console.Error.Write(Usage);
            return 2;
        }
        try
        {
            switch (args[0])
            {
                case "validate": return Validate(args[1..]);
                case "bench": return BenchCmd(args[1..]);
                case "play": return Play(args[1..]);
                case "-h" or "--help" or "help":
                    Console.Out.Write(Usage);
                    return 0;
                default:
                    Console.Error.Write($"unknown command \"{args[0]}\"\n\n{Usage}");
                    return 2;
            }
        }
        catch (UsageException e)
        {
            if (e.Message.Length > 0) Console.Error.WriteLine(e.Message);
            Console.Error.Write(Usage);
            return 2;
        }
        catch (Exception e) when (e is IOException or InvalidDataException or InvalidOperationException
                                      or ArgumentException or UnauthorizedAccessException or FormatException)
        {
            Console.Error.WriteLine("error: " + e.Message);
            return 1;
        }
    }

    private static string DefaultFixtures()
    {
        foreach (string c in new[] { "../../spec/fixtures", "spec/fixtures", "../spec/fixtures", "../../../spec/fixtures" })
            if (Directory.Exists(c)) return c;
        // fall back to the path relative to the published binary (engines/csharp/build/publish)
        string rel = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../spec/fixtures"));
        return Directory.Exists(rel) ? rel : "../../spec/fixtures";
    }

    private static int Validate(string[] args)
    {
        var f = new Flags("validate", ["json", "skip-bench"], ["fixtures"]).Parse(args);
        string dir = f.Get("fixtures") ?? DefaultFixtures();
        var r = Validator.All(dir, f.Bool("skip-bench"));
        if (f.Bool("json"))
        {
            Console.Out.WriteLine(Json.Serialize(r.ToJson(), false));
        }
        else
        {
            Console.Out.WriteLine($"csharp engine {Game.EngineVersion} — fixtures: {dir}");
            foreach (string fx in Validator.Fixtures)
            {
                if (!r.PerFixture.TryGetValue(fx, out var pf)) continue;
                Console.Out.WriteLine($"  {fx,-16} {pf.Passed,4} passed {pf.Failed,4} failed  {(pf.Failed > 0 ? "FAIL" : "ok")}");
            }
            foreach (var fl in r.Failures) Console.Out.WriteLine($"  FAIL {fl.Fixture} [{fl.Case}]: {fl.Message}");
            if (Validator.AiTotal > 0)
                Console.Out.WriteLine($"  ai search values bit-identical to the reference: {Validator.AiExact}/{Validator.AiTotal}");
            Console.Out.WriteLine($"{r.Passed} passed, {r.Failed} failed");
        }
        Console.Out.Flush();
        return r.Failed > 0 ? 1 : 0;
    }

    private static int BenchCmd(string[] args)
    {
        var f = new Flags("bench", [], ["suite", "out"]).Parse(args);
        string? suitePath = f.Get("suite");
        if (string.IsNullOrEmpty(suitePath)) throw new ArgumentException("--suite is required");
        var suite = Suite.Load(suitePath);
        var res = Runner.Run(suite, Console.Error);
        string data = Json.Serialize(res.ToJson(), true) + "\n";
        var s = res.Summary;
        Console.Error.WriteLine(
            $"[{suite.Id}] checksum={res.Checksum} games={s.Games} moves={s.TotalMoves} wall={s.WallMs:F0}ms moves/s={s.MovesPerSec:F0} games/s={s.GamesPerSec:F2} nodes/s={s.NodesPerSec:F0}");
        string? outPath = f.Get("out");
        if (string.IsNullOrEmpty(outPath))
        {
            Console.Out.Write(data);
            Console.Out.Flush();
            return 0;
        }
        string? d = Path.GetDirectoryName(outPath);
        if (!string.IsNullOrEmpty(d)) Directory.CreateDirectory(d);
        File.WriteAllText(outPath, data);
        return 0;
    }

    private static int Play(string[] args)
    {
        var f = new Flags("play", [], ["seed", "agent", "depth", "max-moves"]).Parse(args);
        uint seed = Ids.RandomSeed();
        if (f.Get("seed") is string ss && ss.Length > 0)
        {
            if (!uint.TryParse(ss, out seed)) throw new ArgumentException("--seed must be a uint32");
        }
        string agentId = f.Get("agent", "expectimax");
        string depth = f.Get("depth", "auto");
        if (!int.TryParse(f.Get("max-moves", "0"), out int maxMoves)) throw new ArgumentException("--max-moves must be an integer");
        var cfg = new JsonObject();
        if (depth != "" && depth != "auto")
        {
            if (!int.TryParse(depth, out int n) || n < 1) throw new ArgumentException("--depth must be 'auto' or a positive integer");
            cfg["depth"] = n;
        }
        var agent = Agents.Create(agentId, cfg);
        var pr = Runner.Play(agent, seed, maxMoves, null);
        var snap = pr.Game.Snapshot();
        var o = new JObj
        {
            { "seed", snap.Seed }, { "board", snap.Board }, { "score", snap.Score }, { "moveCount", snap.MoveCount },
            { "maxTile", snap.MaxTile }, { "over", snap.Over }, { "historyHash", snap.HistoryHash },
            { "specVersion", Game.SpecVersion }, { "agent", agentId }, { "nodes", pr.Nodes }, { "wallMs", pr.WallMs },
            { "moves", pr.Game.Moves },
        };
        Console.Out.WriteLine(Json.Serialize(o, true));
        Console.Out.Flush();
        return 0;
    }
}
