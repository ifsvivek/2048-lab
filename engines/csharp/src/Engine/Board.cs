using System;

namespace G2048.Engine;

/// <summary>
/// Board operations. A board is a byte[16] of exponents, row-major (SPEC §1).
/// </summary>
public static class Board
{
    public const int Up = 0, Down = 1, Left = 2, Right = 3;

    /// <summary>Direction index -> replay letter.</summary>
    public const string DirectionLetters = "UDLR";

    public static readonly string[] DirectionNames = ["up", "down", "left", "right"];

    private const string HexDigits = "0123456789abcdefghijklmnopqrstuvwxyz";

    /// <summary>Lines[dir*16 + line*4 + k] = cell index (SPEC §3).</summary>
    private static readonly byte[] Lines = BuildLines();

    private static byte[] BuildLines()
    {
        var t = new byte[64];
        for (int k = 0; k < 4; k++)
        {
            for (int j = 0; j < 4; j++)
            {
                t[Up * 16 + k * 4 + j] = (byte)(j * 4 + k);
                t[Down * 16 + k * 4 + j] = (byte)((3 - j) * 4 + k);
                t[Left * 16 + k * 4 + j] = (byte)(k * 4 + j);
                t[Right * 16 + k * 4 + j] = (byte)(k * 4 + 3 - j);
            }
        }
        return t;
    }

    public static byte[] Empty() => new byte[16];

    /// <summary>Canonical boardHex encoding.</summary>
    public static string Hex(ReadOnlySpan<byte> b)
    {
        Span<char> s = stackalloc char[16];
        for (int i = 0; i < 16; i++) s[i] = HexDigits[b[i]];
        return new string(s);
    }

    /// <summary>Decodes boardHex; throws <see cref="FormatException"/>.</summary>
    public static byte[] FromHex(string hex)
    {
        if (hex.Length != 16) throw new FormatException($"boardHex must be 16 chars, got {hex.Length}");
        var b = new byte[16];
        for (int i = 0; i < 16; i++)
        {
            char c = hex[i];
            if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
            int v = HexDigits.IndexOf(c);
            if (v < 0) throw new FormatException($"invalid boardHex character '{hex[i]}'");
            b[i] = (byte)v;
        }
        return b;
    }

    public static bool TryFromHex(string hex, out byte[] board, out string error)
    {
        try
        {
            board = FromHex(hex);
            error = "";
            return true;
        }
        catch (FormatException e)
        {
            board = new byte[16];
            error = e.Message;
            return false;
        }
    }

    public static int MaxExponent(ReadOnlySpan<byte> b)
    {
        int m = 0;
        for (int i = 0; i < 16; i++) if (b[i] > m) m = b[i];
        return m;
    }

    /// <summary>Largest tile value (0 for an empty board).</summary>
    public static long MaxTile(ReadOnlySpan<byte> b)
    {
        int e = MaxExponent(b);
        return e == 0 ? 0 : 1L << e;
    }

    /// <summary>Applies dir in place. Returns score gained, or -1 if invalid (board untouched).</summary>
    public static long MoveInPlace(Span<byte> b, int dir)
    {
        long gained = 0;
        bool changed = false;
        ReadOnlySpan<byte> lines = Lines.AsSpan(dir * 16, 16);
        Span<byte> tiles = stackalloc byte[4];
        Span<byte> res = stackalloc byte[4];
        for (int l = 0; l < 4; l++)
        {
            ReadOnlySpan<byte> idx = lines.Slice(l * 4, 4);
            int n = 0;
            for (int k = 0; k < 4; k++)
            {
                byte v = b[idx[k]];
                if (v != 0) tiles[n++] = v;
            }
            res.Clear();
            int o = 0;
            for (int i = 0; i < n;)
            {
                if (i + 1 < n && tiles[i] == tiles[i + 1])
                {
                    byte e = (byte)(tiles[i] + 1);
                    res[o] = e;
                    gained += 1L << e;
                    i += 2;
                }
                else
                {
                    res[o] = tiles[i];
                    i++;
                }
                o++;
            }
            for (int k = 0; k < 4; k++)
            {
                if (b[idx[k]] != res[k])
                {
                    b[idx[k]] = res[k];
                    changed = true;
                }
            }
        }
        return changed ? gained : -1;
    }

    /// <summary>Returns the moved board (a copy), the score gained and whether it changed.</summary>
    public static (byte[] Board, long Gained, bool Changed) Move(byte[] b, int dir)
    {
        var nb = (byte[])b.Clone();
        long g = MoveInPlace(nb, dir);
        return g < 0 ? ((byte[])b.Clone(), 0, false) : (nb, g, true);
    }

    /// <summary>Whether dir changes the board.</summary>
    public static bool CanMove(ReadOnlySpan<byte> b, int dir)
    {
        ReadOnlySpan<byte> lines = Lines.AsSpan(dir * 16, 16);
        for (int l = 0; l < 4; l++)
        {
            int o = l * 4;
            for (int k = 1; k < 4; k++)
            {
                byte prev = b[lines[o + k - 1]], cur = b[lines[o + k]];
                if (cur != 0 && (prev == 0 || prev == cur)) return true;
            }
        }
        return false;
    }

    public static int[] ValidMoves(ReadOnlySpan<byte> b)
    {
        Span<int> tmp = stackalloc int[4];
        int n = 0;
        for (int d = 0; d < 4; d++) if (CanMove(b, d)) tmp[n++] = d;
        return tmp[..n].ToArray();
    }

    public static bool IsOver(ReadOnlySpan<byte> b)
    {
        for (int d = 0; d < 4; d++) if (CanMove(b, d)) return false;
        return true;
    }

    /// <summary>Places a tile per SPEC §5. Returns false (no draws) if the board is full.</summary>
    public static bool Spawn(Span<byte> b, Rng r, out int index, out byte exponent)
    {
        Span<int> empties = stackalloc int[16];
        int n = 0;
        for (int i = 0; i < 16; i++) if (b[i] == 0) empties[n++] = i;
        if (n == 0)
        {
            index = 0;
            exponent = 0;
            return false;
        }
        index = empties[(int)r.Below((ulong)n)];
        exponent = r.Below(10) == 0 ? (byte)2 : (byte)1;
        b[index] = exponent;
        return true;
    }

    public static bool Spawn(Span<byte> b, Rng r) => Spawn(b, r, out _, out _);

    /// <summary>Accepts names ("left"), letters ("L") or digits ("2").</summary>
    public static int ParseDirection(string s)
    {
        string t = s.Trim().ToLowerInvariant();
        for (int i = 0; i < 4; i++) if (t == DirectionNames[i]) return i;
        if (t.Length == 1)
        {
            int i = "udlr".IndexOf(t[0]);
            if (i >= 0) return i;
            if (t[0] >= '0' && t[0] <= '3') return t[0] - '0';
        }
        throw new FormatException($"invalid direction '{s}'");
    }
}
