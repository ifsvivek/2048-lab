using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace G2048.Ai;

/// <summary>Integer heuristic weights (AI.md §2).</summary>
public readonly record struct Weights(long Lost, long Empty, long Merges, long Mono, long Sum, long Smooth, long Stable, long Corner)
{
    /// <summary>The canonical profile HEURISTIC_V1.</summary>
    public static readonly Weights V1 = new(200000, 270, 700, 47, 11, 0, 0, 0);
}

/// <summary>Per-line heuristic features.</summary>
public record struct LineFeatures(long Empty, long Merges, long Mono, long Sum, long Smooth, long Stable);

/// <summary>Heuristic decomposition summed over all 8 lines.</summary>
public readonly record struct Breakdown(LineFeatures Features, double Corner, double Total);

public static class Heuristic
{
    /// <summary>Features of a 16-bit line value.</summary>
    public static LineFeatures Features(ushort v)
    {
        Span<long> r = [v & 0xf, (v >> 4) & 0xf, (v >> 8) & 0xf, (v >> 12) & 0xf];
        var f = new LineFeatures();
        long prev = 0, counter = 0;
        foreach (long rank in r)
        {
            f.Sum += rank * rank * rank;
            if (rank == 0)
            {
                f.Empty++;
                continue;
            }
            if (prev == rank)
            {
                counter++;
            }
            else if (counter > 0)
            {
                f.Merges += 1 + counter;
                counter = 0;
            }
            prev = rank;
        }
        if (counter > 0) f.Merges += 1 + counter;
        long monoL = 0, monoR = 0;
        for (int i = 1; i < 4; i++)
        {
            long a = r[i - 1] * r[i - 1] * r[i - 1] * r[i - 1];
            long b = r[i] * r[i] * r[i] * r[i];
            if (r[i - 1] > r[i]) monoL += a - b;
            else monoR += b - a;
            if (r[i - 1] != 0 && r[i] != 0) f.Smooth += Math.Abs(r[i - 1] - r[i]);
        }
        if (f.Empty == 0 && (monoL == 0 || monoR == 0)) f.Stable = 1;
        f.Mono = Math.Min(monoL, monoR);
        return f;
    }

    public static long LineScore(LineFeatures f, Weights w) =>
        w.Lost + w.Empty * f.Empty + w.Merges * f.Merges - w.Mono * f.Mono - w.Sum * f.Sum
        - w.Smooth * f.Smooth + w.Stable * f.Stable;

    private static readonly Dictionary<Weights, double[]> Cache = [];

    /// <summary>Memoised 65536-entry per-line score table.</summary>
    public static double[] LineTable(Weights w)
    {
        lock (Cache)
        {
            if (Cache.TryGetValue(w, out var t)) return t;
            t = new double[65536];
            for (int v = 0; v < 65536; v++) t[v] = LineScore(Features((ushort)v), w);
            Cache[w] = t;
            return t;
        }
    }

    /// <summary>W.corner * maxRank if a corner holds the max rank, else 0.</summary>
    public static double CornerTerm(ulong b, long cornerWeight)
    {
        if (cornerWeight == 0) return 0;
        ulong mx = 0;
        for (int i = 0; i < 16; i++)
        {
            ulong n = (b >> (4 * i)) & 0xf;
            if (n > mx) mx = n;
        }
        if ((b & 0xf) == mx || ((b >> 12) & 0xf) == mx || ((b >> 48) & 0xf) == mx || (b >> 60) == mx)
            return cornerWeight * (long)mx;
        return 0;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static double At(ref double t, ulong i) => Unsafe.Add(ref t, (nint)(i & 0xffff));

    /// <summary>Heuristic value of a bitboard.</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static double Evaluate(ulong b, double[] table, long cornerWeight)
    {
        ref double t = ref MemoryMarshal.GetArrayDataReference(table);
        double v = At(ref t, b) + At(ref t, b >> 16) + At(ref t, b >> 32) + At(ref t, b >> 48)
            + At(ref t, Bitboard.Column(b, 0)) + At(ref t, Bitboard.Column(b, 1))
            + At(ref t, Bitboard.Column(b, 2)) + At(ref t, Bitboard.Column(b, 3));
        if (cornerWeight != 0) v += CornerTerm(b, cornerWeight);
        return v;
    }

    public static Breakdown BreakdownOf(ulong b, Weights w)
    {
        ushort[] lines =
        [
            (ushort)b, (ushort)(b >> 16), (ushort)(b >> 32), (ushort)(b >> 48),
            Bitboard.Column(b, 0), Bitboard.Column(b, 1), Bitboard.Column(b, 2), Bitboard.Column(b, 3),
        ];
        var acc = new LineFeatures();
        foreach (ushort v in lines)
        {
            var f = Features(v);
            acc.Empty += f.Empty;
            acc.Merges += f.Merges;
            acc.Mono += f.Mono;
            acc.Sum += f.Sum;
            acc.Smooth += f.Smooth;
            acc.Stable += f.Stable;
        }
        return new Breakdown(acc, CornerTerm(b, w.Corner), Evaluate(b, LineTable(w), w.Corner));
    }
}
