using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using G2048.Engine;

namespace G2048.Ai;

/// <summary>
/// uint64 bitboard: cell i occupies bits 4i..4i+3 (AI.md §1), with 65536-entry
/// line tables. Moves saturate at rank 15.
/// </summary>
public static class Bitboard
{
    /// <summary>Slides toward the low nibble ("left" for rows, "up" for columns).</summary>
    private static readonly ushort[] TowardLow = new ushort[65536];

    /// <summary>Slides toward the high nibble ("right" / "down").</summary>
    private static readonly ushort[] TowardHigh = new ushort[65536];

    /// <summary>Places a line value as column 0 (nibble k -> row k).</summary>
    private static readonly ulong[] SpreadCol = new ulong[65536];

    private static ushort ReverseLine(int v) =>
        (ushort)(((v & 0xf) << 12) | (((v >> 4) & 0xf) << 8) | (((v >> 8) & 0xf) << 4) | ((v >> 12) & 0xf));

    static Bitboard()
    {
        System.Span<int> r = stackalloc int[4];
        System.Span<int> tiles = stackalloc int[4];
        System.Span<int> o = stackalloc int[4];
        for (int v = 0; v < 65536; v++)
        {
            for (int k = 0; k < 4; k++) r[k] = (v >> (4 * k)) & 0xf;
            int n = 0;
            foreach (int x in r) if (x != 0) tiles[n++] = x;
            o.Clear();
            int w = 0;
            for (int i = 0; i < n; i++)
            {
                if (i + 1 < n && tiles[i] == tiles[i + 1])
                {
                    o[w] = System.Math.Min(tiles[i] + 1, 15);
                    i++;
                }
                else
                {
                    o[w] = tiles[i];
                }
                w++;
            }
            TowardLow[v] = (ushort)(o[0] | (o[1] << 4) | (o[2] << 8) | (o[3] << 12));
            SpreadCol[v] = (ulong)(uint)r[0] | ((ulong)(uint)r[1] << 16) | ((ulong)(uint)r[2] << 32) | ((ulong)(uint)r[3] << 48);
        }
        for (int v = 0; v < 65536; v++) TowardHigh[v] = ReverseLine(TowardLow[ReverseLine(v)]);
    }

    /// <summary>Column c as a line value (row 0 in the lowest nibble).</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ushort Column(ulong b, int c)
    {
        ulong x = b >> (4 * c);
        return (ushort)((x & 0xf) | (((x >> 16) & 0xf) << 4) | (((x >> 32) & 0xf) << 8) | (((x >> 48) & 0xf) << 12));
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static T At<T>(T[] table, ulong index) where T : unmanaged =>
        Unsafe.Add(ref MemoryMarshal.GetArrayDataReference(table), (nint)(index & 0xffff));

    /// <summary>Applies dir (saturating at rank 15); the result equals b if the move is invalid.</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static ulong Move(ulong b, int dir)
    {
        switch (dir)
        {
            case Board.Left:
            case Board.Right:
            {
                ushort[] t = dir == Board.Right ? TowardHigh : TowardLow;
                return At(t, b) | ((ulong)At(t, b >> 16) << 16) | ((ulong)At(t, b >> 32) << 32) | ((ulong)At(t, b >> 48) << 48);
            }
            default:
            {
                ushort[] t = dir == Board.Down ? TowardHigh : TowardLow;
                return At(SpreadCol, At(t, Column(b, 0)))
                    | (At(SpreadCol, At(t, Column(b, 1))) << 4)
                    | (At(SpreadCol, At(t, Column(b, 2))) << 8)
                    | (At(SpreadCol, At(t, Column(b, 3))) << 12);
            }
        }
    }

    /// <summary>Converts a game board, clamping exponents above 15.</summary>
    public static ulong FromBoard(System.ReadOnlySpan<byte> board)
    {
        ulong b = 0;
        for (int i = 0; i < 16; i++) b |= (ulong)System.Math.Min((int)board[i], 15) << (4 * i);
        return b;
    }

    public static byte[] ToBoard(ulong b)
    {
        var o = new byte[16];
        for (int i = 0; i < 16; i++) o[i] = (byte)((b >> (4 * i)) & 0xf);
        return o;
    }

    /// <summary>Number of distinct non-zero ranks.</summary>
    public static int DistinctRanks(ulong b)
    {
        uint mask = 0;
        for (int i = 0; i < 16; i++) mask |= 1u << (int)((b >> (4 * i)) & 0xf);
        mask &= ~1u;
        return System.Numerics.BitOperations.PopCount(mask);
    }

    /// <summary>Number of empty cells.</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static int CountEmpty(ulong b)
    {
        // nibble is non-zero iff any of its bits is set
        ulong x = b | (b >> 1);
        x |= x >> 2;
        x &= 0x1111111111111111UL;
        return 16 - System.Numerics.BitOperations.PopCount(x);
    }
}
