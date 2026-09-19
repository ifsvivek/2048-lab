using System;
using System.Diagnostics;
using System.Text.Json.Nodes;
using G2048.Engine;

namespace G2048.Ai;

/// <summary>Per-decision metrics (AI.md §4).</summary>
public sealed record Metrics(
    long TimeUs,
    bool Deterministic,
    int? Depth = null,
    long? Nodes = null,
    long? TTHits = null,
    int? TTSize = null,
    double?[]? Values = null,
    Breakdown? Heuristic = null,
    int[]? CompletedDepths = null);

/// <summary>An agent's chosen move plus metrics.</summary>
public readonly record struct Decision(int Move, Metrics Metrics);

public interface IAgent
{
    string Id { get; }

    /// <summary>Called once per game before the first decision.</summary>
    void Reset(uint seed);

    /// <summary>Returns a valid move; only called when at least one move is valid.</summary>
    Decision Decide(byte[] board);

    /// <summary>Whether decisions are reproducible.</summary>
    bool Deterministic => true;
}

/// <summary>SPEC §10 reference random agent.</summary>
public sealed class RandomAgent : IAgent
{
    private Rng _rng = Rng.FromSeed(0);

    public string Id => "random";

    public void Reset(uint seed) => _rng = Rng.FromSeed(seed ^ 0xA5A5A5A5);

    public Decision Decide(byte[] board)
    {
        long t = Stopwatch.GetTimestamp();
        Span<int> valid = stackalloc int[4];
        int n = 0;
        for (int d = 0; d < 4; d++) if (Board.CanMove(board, d)) valid[n++] = d;
        int mv = valid[(int)_rng.Below((ulong)n)];
        return new Decision(mv, new Metrics(Timing.ElapsedUs(t), true));
    }
}

/// <summary>Maximises empty cells after the move; ties go to the lower direction.</summary>
public sealed class GreedyAgent : IAgent
{
    public string Id => "greedy";

    public void Reset(uint seed) { }

    public Decision Decide(byte[] board)
    {
        long t = Stopwatch.GetTimestamp();
        ulong b = Bitboard.FromBoard(board);
        var valid = Board.ValidMoves(board);
        int best = valid.Length > 0 ? valid[0] : -1;
        int bestScore = -1;
        for (int d = 0; d < 4; d++)
        {
            ulong nb = Bitboard.Move(b, d);
            if (nb == b) continue;
            int empty = Bitboard.CountEmpty(nb);
            if (empty > bestScore)
            {
                bestScore = empty;
                best = d;
            }
        }
        return new Decision(best, new Metrics(Timing.ElapsedUs(t), true));
    }
}

/// <summary>Wraps <see cref="Search"/>.</summary>
public sealed class ExpectimaxAgent(Config c) : IAgent
{
    public Search Search { get; } = new(c);
    public SearchResult? LastResult { get; private set; }

    public string Id => "expectimax";

    public bool Deterministic => !(Search.Config.TimeBudgetMs > 0);

    public void Reset(uint seed) { }

    public Decision Decide(byte[] board)
    {
        ulong b = Bitboard.FromBoard(board);
        var r = Search.Run(b);
        LastResult = r;
        int mv = r.Move;
        if (mv < 0)
        {
            var v = Board.ValidMoves(board);
            if (v.Length > 0) mv = v[0];
        }
        var h = Heuristic.BreakdownOf(b, Search.Config.Weights);
        return new Decision(mv, new Metrics(r.TimeUs, r.Deterministic, r.Depth, r.Nodes, r.TTHits, r.TTSize, r.Values, h, r.CompletedDepths));
    }
}

public static class Agents
{
    /// <summary>Creates a built-in agent by id ("random", "greedy", "expectimax").</summary>
    public static IAgent Create(string id, JsonObject? config) => id switch
    {
        "random" => new RandomAgent(),
        "greedy" => new GreedyAgent(),
        "expectimax" => new ExpectimaxAgent(Config.Parse(config)),
        _ => throw new ArgumentException($"unknown agent '{id}'"),
    };
}
