using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace G2048.Ai;

/// <summary>Expectimax configuration (AI.md §3).</summary>
public sealed class Config
{
    /// <summary>depth = clamp(distinct-2, MinDepth, MaxDepth) when set; otherwise Depth is fixed.</summary>
    public bool AutoDepth { get; set; } = true;
    public int Depth { get; set; }
    public int MinDepth { get; set; } = 2;
    public int MaxDepth { get; set; } = 4;
    public int FourPruneEmpties { get; set; }
    /// <summary>&gt; 0 enables iterative deepening (non-deterministic).</summary>
    public double TimeBudgetMs { get; set; }
    /// <summary>log2 of the transposition-table slot count.</summary>
    public int TTBits { get; set; } = 20;
    public Weights Weights { get; set; } = Weights.V1;

    public static Config Canonical() => new();

    private static bool TryNumber(JsonNode? v, out double d)
    {
        d = 0;
        return v is JsonValue jv && jv.GetValueKind() == JsonValueKind.Number
            && double.TryParse(jv.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out d);
    }

    private static long AsInt(string key, JsonNode? v)
    {
        if (!TryNumber(v, out double f)) throw new ArgumentException($"config {key} must be a number");
        if (f != Math.Truncate(f) || double.IsInfinity(f)) throw new ArgumentException($"config {key} must be an integer (got {f})");
        return (long)f;
    }

    /// <summary>Overlays a JSON config object onto the canonical profile; throws ArgumentException.</summary>
    public static Config Parse(JsonObject? m)
    {
        var c = Canonical();
        if (m is null) return c;
        foreach (var (k, v) in m)
        {
            switch (k)
            {
                case "depth":
                    if (v is JsonValue sv && sv.GetValueKind() == JsonValueKind.String)
                    {
                        if (sv.GetValue<string>() != "auto") throw new ArgumentException("config depth must be an integer or \"auto\"");
                        c.AutoDepth = true;
                    }
                    else
                    {
                        long n = AsInt(k, v);
                        if (n < 1) throw new ArgumentException("config depth must be >= 1");
                        c.AutoDepth = false;
                        c.Depth = (int)n;
                    }
                    break;
                case "minDepth": c.MinDepth = (int)AsInt(k, v); break;
                case "maxDepth": c.MaxDepth = (int)AsInt(k, v); break;
                case "fourPruneEmpties": c.FourPruneEmpties = (int)AsInt(k, v); break;
                case "timeBudgetMs":
                    if (!TryNumber(v, out double tb)) throw new ArgumentException("config timeBudgetMs must be a number");
                    c.TimeBudgetMs = tb;
                    break;
                case "ttBits":
                {
                    long n = AsInt(k, v);
                    if (n < 4 || n > 28) throw new ArgumentException("config ttBits out of range");
                    c.TTBits = (int)n;
                    break;
                }
                case "weights":
                {
                    if (v is not JsonObject wm) throw new ArgumentException("config weights must be an object");
                    var w = c.Weights;
                    foreach (var (wk, wv) in wm)
                    {
                        long n;
                        try { n = AsInt("weights." + wk, wv); }
                        catch (ArgumentException) { throw new ArgumentException($"heuristic weight '{wk}' must be an integer (got {wv?.ToJsonString()})"); }
                        w = wk switch
                        {
                            "lost" => w with { Lost = n },
                            "empty" => w with { Empty = n },
                            "merges" => w with { Merges = n },
                            "mono" => w with { Mono = n },
                            "sum" => w with { Sum = n },
                            "smooth" => w with { Smooth = n },
                            "stable" => w with { Stable = n },
                            "corner" => w with { Corner = n },
                            _ => w,
                        };
                    }
                    c.Weights = w;
                    break;
                }
            }
        }
        return c;
    }
}

/// <summary>Outcome of one search.</summary>
public sealed class SearchResult
{
    /// <summary>-1 if no valid move.</summary>
    public int Move { get; init; } = -1;
    public double Value { get; init; }
    public double?[] Values { get; init; } = new double?[4];
    public int Depth { get; init; }
    public long Nodes { get; init; }
    public long TTHits { get; init; }
    public int TTSize { get; init; }
    public long TimeUs { get; init; }
    public bool Deterministic { get; init; }
    public int[] CompletedDepths { get; init; } = [];
}

/// <summary>Reusable expectimax searcher (not thread-safe).</summary>
public sealed class Search
{
    public Config Config { get; }

    private readonly double[] _table;
    private readonly long _corner;

    // Transposition table: exact key (board, depth). Mirrors the TS reference
    // (hash, 4-slot linear probe, store policy, clear at 75%) so node and hit
    // counts are comparable across ports.
    private readonly uint _ttMask;
    private readonly ulong[] _ttBoard;
    private readonly byte[] _ttDepth;
    private readonly double[] _ttValue;
    private int _ttSize;

    private long _nodes;
    private long _ttHits;
    private long _deadline;
    private bool _timed;
    private bool _aborted;

    public Search(Config c)
    {
        if (c.TTBits == 0) c.TTBits = 20;
        Config = c;
        _table = Heuristic.LineTable(c.Weights);
        _corner = c.Weights.Corner;
        int n = 1 << c.TTBits;
        _ttMask = (uint)(n - 1);
        _ttBoard = new ulong[n];
        _ttDepth = new byte[n];
        _ttValue = new double[n];
    }

    public double Evaluate(ulong b) => Heuristic.Evaluate(b, _table, _corner);

    public int DepthFor(ulong b)
    {
        var c = Config;
        if (!c.AutoDepth) return c.Depth;
        return Math.Max(c.MinDepth, Math.Min(c.MaxDepth, Bitboard.DistinctRanks(b) - 2));
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private uint Slot(ulong b, int d)
    {
        unchecked
        {
            uint lo = (uint)b, hi = (uint)(b >> 32);
            uint h = ((lo ^ ((uint)d * 0x9e3779b1)) * 0x85ebca6b) ^ (hi * 0xc2b2ae35);
            h ^= h >> 15;
            h *= 0x2c1b3c6d;
            h ^= h >> 12;
            return h & _ttMask;
        }
    }

    private double MaxNode(ulong b, int d)
    {
        _nodes++;
        if (d == 0) return Heuristic.Evaluate(b, _table, _corner);
        double best = 0.0;
        for (int dir = 0; dir < 4; dir++)
        {
            ulong nb = Bitboard.Move(b, dir);
            if (nb == b) continue;
            double v = Chance(nb, d);
            if (_aborted) return 0;
            if (v > best) best = v;
        }
        return best;
    }

    private double Chance(ulong b, int d)
    {
        _nodes++;
        if (_timed && (_nodes & 0xfff) == 0 && Stopwatch.GetTimestamp() > _deadline)
        {
            _aborted = true;
            return 0;
        }
        ref ulong ttBoard = ref MemoryMarshal.GetArrayDataReference(_ttBoard);
        ref byte ttDepth = ref MemoryMarshal.GetArrayDataReference(_ttDepth);
        ref double ttValue = ref MemoryMarshal.GetArrayDataReference(_ttValue);
        uint mask = _ttMask;
        uint home = Slot(b, d);
        uint sl = home;
        for (int probe = 0; probe < 4; probe++)
        {
            byte sd = Unsafe.Add(ref ttDepth, (nint)sl);
            if (sd == 0) break;
            if (sd == d && Unsafe.Add(ref ttBoard, (nint)sl) == b)
            {
                _ttHits++;
                return Unsafe.Add(ref ttValue, (nint)sl);
            }
            sl = (sl + 1) & mask;
        }

        int n = Bitboard.CountEmpty(b);
        int p = Config.FourPruneEmpties;
        bool four = !(p > 0 && n >= p);
        double sum = 0.0;
        for (int i = 0; i < 16; i++)
        {
            int sh = 4 * i;
            if (((b >> sh) & 0xf) != 0) continue;
            if (four)
            {
                double v2 = MaxNode(b | (1UL << sh), d - 1);
                if (_aborted) return 0;
                // explicit product then add: RyuJIT never contracts this into FMA
                double p2 = 0.9 * v2;
                sum += p2;
                double v4 = MaxNode(b | (2UL << sh), d - 1);
                if (_aborted) return 0;
                double p4 = 0.1 * v4;
                sum += p4;
            }
            else
            {
                double v2 = MaxNode(b | (1UL << sh), d - 1);
                if (_aborted) return 0;
                sum += v2;
            }
        }
        double v = sum / n;

        uint target = home;
        sl = home;
        for (int probe = 0; probe < 4; probe++)
        {
            if (Unsafe.Add(ref ttDepth, (nint)sl) == 0)
            {
                target = sl;
                _ttSize++;
                break;
            }
            sl = (sl + 1) & mask;
        }
        Unsafe.Add(ref ttBoard, (nint)target) = b;
        Unsafe.Add(ref ttDepth, (nint)target) = (byte)d;
        Unsafe.Add(ref ttValue, (nint)target) = v;
        return v;
    }

    private (int Move, double Value, double?[] Values, bool Ok) Root(ulong b, int depth)
    {
        int move = -1;
        double value = double.NegativeInfinity;
        var values = new double?[4];
        for (int dir = 0; dir < 4; dir++)
        {
            ulong nb = Bitboard.Move(b, dir);
            if (nb == b) continue;
            double v = Chance(nb, depth);
            if (_aborted) return (move, value, values, false);
            values[dir] = v;
            if (v > value)
            {
                value = v;
                move = dir;
            }
        }
        return (move, value, values, true);
    }

    /// <summary>Searches b and returns the decision.</summary>
    public SearchResult Run(ulong b)
    {
        long start = Stopwatch.GetTimestamp();
        _nodes = 0;
        _ttHits = 0;
        _aborted = false;
        _timed = false;
        if (_ttSize > (_ttMask + 1.0) * 0.75)
        {
            Array.Clear(_ttDepth);
            _ttSize = 0;
        }
        if (Config.TimeBudgetMs <= 0)
        {
            int depth = DepthFor(b);
            var r = Root(b, depth);
            return Result(r.Move, r.Value, r.Values, depth, start, true, [depth]);
        }
        var best = Root(b, 1);
        int bestDepth = 1;
        var completed = new List<int> { 1 };
        _timed = true;
        _deadline = start + (long)(Config.TimeBudgetMs * Stopwatch.Frequency / 1000.0);
        for (int d = 2; d <= Config.MaxDepth; d++)
        {
            var r = Root(b, d);
            if (!r.Ok) break;
            best = r;
            bestDepth = d;
            completed.Add(d);
        }
        _timed = false;
        _aborted = false;
        return Result(best.Move, best.Value, best.Values, bestDepth, start, false, completed.ToArray());
    }

    private SearchResult Result(int move, double value, double?[] values, int depth, long start, bool det, int[] completed) =>
        new()
        {
            Move = move, Value = value, Values = values, Depth = depth,
            Nodes = _nodes, TTHits = _ttHits, TTSize = _ttSize,
            TimeUs = Timing.ElapsedUs(start), Deterministic = det, CompletedDepths = completed,
        };
}

/// <summary>Monotonic timing helpers.</summary>
public static class Timing
{
    public static long ElapsedNs(long start) =>
        (long)((Stopwatch.GetTimestamp() - start) * (1e9 / Stopwatch.Frequency));

    /// <summary>Elapsed microseconds, rounded half away from zero (Go math.Round).</summary>
    public static long ElapsedUs(long start) => (long)Math.Round(ElapsedNs(start) / 1000.0, MidpointRounding.AwayFromZero);

    public static double ElapsedMs(long start) => ElapsedNs(start) / 1e6;
}
