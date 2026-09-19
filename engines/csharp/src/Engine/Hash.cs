using System;

namespace G2048.Engine;

/// <summary>FNV-1a hashes (SPEC §7).</summary>
public static class Hash
{
    private const uint Offset = 0x811C9DC5;
    private const uint Prime = 0x01000193;

    public static uint Fnv1a32(ReadOnlySpan<byte> data)
    {
        uint h = Offset;
        foreach (byte c in data) h = unchecked((h ^ c) * Prime);
        return h;
    }

    /// <summary>fnv1a32 over the 16 exponent bytes.</summary>
    public static uint BoardHash(ReadOnlySpan<byte> b) => Fnv1a32(b[..16]);

    /// <summary>fnv1a32(le32(h) ++ board ++ [dir]).</summary>
    public static uint HistoryStep(uint h, ReadOnlySpan<byte> b, int dir)
    {
        unchecked
        {
            uint x = Offset;
            for (int k = 0; k < 4; k++) x = (x ^ ((h >> (8 * k)) & 0xff)) * Prime;
            for (int i = 0; i < 16; i++) x = (x ^ b[i]) * Prime;
            return (x ^ (uint)dir) * Prime;
        }
    }

    /// <summary>8 lowercase hex digits.</summary>
    public static string Hex(uint h) => h.ToString("x8");
}
