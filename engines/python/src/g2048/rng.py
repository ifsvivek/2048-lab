"""SPEC §4 — mix32 seed expansion and xoshiro128** (all arithmetic uint32)."""

from __future__ import annotations

M32 = 0xFFFFFFFF
_TWO32 = 1 << 32


def mix32(seed: int) -> list[int]:
    """Expand a uint32 seed into four xoshiro128** state words."""
    x = seed & M32
    s = []
    for _ in range(4):
        x = (x + 0x9E3779B9) & M32
        z = x
        z = ((z ^ (z >> 16)) * 0x85EBCA6B) & M32
        z = ((z ^ (z >> 13)) * 0xC2B2AE35) & M32
        s.append(z ^ (z >> 16))
    if s[0] == 0 and s[1] == 0 and s[2] == 0 and s[3] == 0:
        s[0] = 1
    return s


class Rng:
    """xoshiro128** generator."""

    __slots__ = ("s0", "s1", "s2", "s3")

    def __init__(self, state) -> None:
        self.s0, self.s1, self.s2, self.s3 = (int(v) & M32 for v in state)

    @classmethod
    def from_seed(cls, seed: int) -> "Rng":
        return cls(mix32(seed))

    def next(self) -> int:
        s0 = self.s0
        s1 = self.s1
        s2 = self.s2
        s3 = self.s3
        x = (s1 * 5) & M32
        result = ((((x << 7) | (x >> 25)) & M32) * 9) & M32
        t = (s1 << 9) & M32
        s2 ^= s0
        s3 ^= s1
        s1 ^= s2
        s0 ^= s3
        s2 ^= t
        s3 = ((s3 << 11) | (s3 >> 21)) & M32
        self.s0 = s0
        self.s1 = s1
        self.s2 = s2
        self.s3 = s3
        return result

    def below(self, n: int) -> int:
        """Unbiased integer in [0, n) by rejection sampling (SPEC §4.3)."""
        limit = _TWO32 - (_TWO32 % n)
        s0 = self.s0
        s1 = self.s1
        s2 = self.s2
        s3 = self.s3
        while True:
            # inlined next()
            x = (s1 * 5) & M32
            x = ((((x << 7) | (x >> 25)) & M32) * 9) & M32
            t = (s1 << 9) & M32
            s2 ^= s0
            s3 ^= s1
            s1 ^= s2
            s0 ^= s3
            s2 ^= t
            s3 = ((s3 << 11) | (s3 >> 21)) & M32
            if x < limit:
                self.s0 = s0
                self.s1 = s1
                self.s2 = s2
                self.s3 = s3
                return x % n

    def state(self) -> list[int]:
        return [self.s0, self.s1, self.s2, self.s3]

    def clone(self) -> "Rng":
        return Rng(self.state())
