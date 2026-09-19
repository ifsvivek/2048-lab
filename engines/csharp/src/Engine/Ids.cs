using System;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace G2048.Engine;

/// <summary>Seeds, ULIDs and replay codes (SPEC §9).</summary>
public static partial class Ids
{
    public const string ReplayAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private const string Crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    /// <summary>uint32 seed from a CSPRNG.</summary>
    public static uint RandomSeed() => BinaryPrimitives.ReadUInt32LittleEndian(RandomNumberGenerator.GetBytes(4));

    public static string Ulid(DateTimeOffset now)
    {
        ulong t = (ulong)now.ToUnixTimeMilliseconds();
        Span<char> o = stackalloc char[26];
        for (int i = 9; i >= 0; i--)
        {
            o[i] = Crockford[(int)(t % 32)];
            t /= 32;
        }
        byte[] rnd = RandomNumberGenerator.GetBytes(16);
        for (int i = 0; i < 16; i++) o[10 + i] = Crockford[rnd[i] & 31];
        return new string(o);
    }

    [GeneratedRegex("^[0-9A-HJKMNP-TV-Z]{26}$")]
    private static partial Regex UlidRegex();

    public static bool IsUlid(string s) => UlidRegex().IsMatch(s);

    public static string GenerateReplayCode()
    {
        byte[] rnd = RandomNumberGenerator.GetBytes(12);
        var s = new char[12];
        for (int i = 0; i < 12; i++) s[i] = ReplayAlphabet[rnd[i] & 31];
        return FormatReplayCode(new string(s));
    }

    /// <summary>Upper-cases, strips non [A-Z0-9], and validates; null if invalid.</summary>
    public static string? NormalizeReplayCode(string input)
    {
        var sb = new StringBuilder();
        foreach (char c0 in input)
        {
            char c = char.ToUpperInvariant(c0);
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) sb.Append(c);
        }
        string s = sb.ToString();
        if (s.Length != 12) return null;
        foreach (char c in s) if (ReplayAlphabet.IndexOf(c) < 0) return null;
        return s;
    }

    /// <summary>XXXX-XXXX-XXXX.</summary>
    public static string FormatReplayCode(string n) => $"{n[..4]}-{n[4..8]}-{n[8..12]}";
}
