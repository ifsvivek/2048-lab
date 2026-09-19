//! SPEC §4 — seed expansion (mix32) and xoshiro128**. All arithmetic is u32
//! with explicit wrap-around.

/// Expand a 32-bit seed into the four xoshiro128** state words.
pub fn mix32(seed: u32) -> [u32; 4] {
    let mut x: u32 = seed;
    let mut s: [u32; 4] = [0; 4];
    for k in 0..4usize {
        x = x.wrapping_add(0x9E37_79B9);
        let mut z: u32 = x;
        z = (z ^ (z >> 16)).wrapping_mul(0x85EB_CA6B);
        z = (z ^ (z >> 13)).wrapping_mul(0xC2B2_AE35);
        s[k] = z ^ (z >> 16);
    }
    if s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 {
        s[0] = 1;
    }
    s
}

/// xoshiro128** generator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rng {
    s: [u32; 4],
}

impl Rng {
    pub fn new(state: [u32; 4]) -> Rng {
        Rng { s: state }
    }

    pub fn from_seed(seed: u32) -> Rng {
        Rng::new(mix32(seed))
    }

    pub fn next_u32(&mut self) -> u32 {
        let mut s0: u32 = self.s[0];
        let mut s1: u32 = self.s[1];
        let mut s2: u32 = self.s[2];
        let mut s3: u32 = self.s[3];
        let result: u32 = s1.wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t: u32 = s1 << 9;
        s2 ^= s0;
        s3 ^= s1;
        s1 ^= s2;
        s0 ^= s3;
        s2 ^= t;
        s3 = s3.rotate_left(11);
        self.s = [s0, s1, s2, s3];
        result
    }

    /// Unbiased integer in `[0, n)` by rejection sampling (SPEC §4.3).
    /// `n` must be in `1..=2^32`.
    pub fn below(&mut self, n: u64) -> u32 {
        assert!(n >= 1 && n <= (1u64 << 32), "below(n) requires 1 <= n <= 2^32");
        let two32: u64 = 1u64 << 32;
        let limit: u64 = two32 - (two32 % n);
        loop {
            let x: u64 = self.next_u32() as u64;
            if x < limit {
                return (x % n) as u32;
            }
        }
    }

    pub fn state(&self) -> [u32; 4] {
        self.s
    }
}
