namespace G2048.Engine;

/// <summary>xoshiro128** seeded via mix32 (SPEC §4).</summary>
public sealed class Rng
{
    public uint S0, S1, S2, S3;

    public Rng(uint s0, uint s1, uint s2, uint s3)
    {
        S0 = s0; S1 = s1; S2 = s2; S3 = s3;
    }

    public Rng(uint[] state) : this(state[0], state[1], state[2], state[3]) { }

    /// <summary>Generator seeded via <see cref="Mix32"/>.</summary>
    public static Rng FromSeed(uint seed) => new(Mix32(seed));

    /// <summary>Expands a seed into generator state (SPEC §4.1).</summary>
    public static uint[] Mix32(uint seed)
    {
        var s = new uint[4];
        uint x = seed;
        for (int k = 0; k < 4; k++)
        {
            unchecked
            {
                x += 0x9E3779B9;
                uint z = x;
                z = (z ^ (z >> 16)) * 0x85EBCA6B;
                z = (z ^ (z >> 13)) * 0xC2B2AE35;
                s[k] = z ^ (z >> 16);
            }
        }
        if (s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0) s[0] = 1;
        return s;
    }

    private static uint Rotl(uint x, int k) => (x << k) | (x >> (32 - k));

    /// <summary>Next 32-bit output (SPEC §4.2).</summary>
    public uint Next()
    {
        unchecked
        {
            uint result = Rotl(S1 * 5, 7) * 9;
            uint t = S1 << 9;
            S2 ^= S0;
            S3 ^= S1;
            S1 ^= S2;
            S0 ^= S3;
            S2 ^= t;
            S3 = Rotl(S3, 11);
            return result;
        }
    }

    /// <summary>Unbiased integer in [0, n), 1 &lt;= n &lt;= 2^32 (SPEC §4.3).</summary>
    public uint Below(ulong n)
    {
        const ulong two32 = 1UL << 32;
        ulong limit = two32 - two32 % n;
        while (true)
        {
            ulong x = Next();
            if (x < limit) return (uint)(x % n);
        }
    }

    public uint[] State() => [S0, S1, S2, S3];

    public Rng Clone() => new(S0, S1, S2, S3);

    public bool SameState(Rng o) => S0 == o.S0 && S1 == o.S1 && S2 == o.S2 && S3 == o.S3;
}
