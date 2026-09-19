//! SPEC §9 — seeds, game IDs (ULID) and human-friendly replay codes.
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::rng::{mix32, Rng};

pub const REPLAY_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

static FALLBACK_COUNTER: AtomicU32 = AtomicU32::new(0);

/// `n` random bytes from /dev/urandom, falling back to a time/address/counter mix.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf: Vec<u8> = vec![0u8; n];
    if let Ok(mut f) = File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf;
        }
    }
    let nanos: u128 = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_nanos(),
        Err(_) => 0,
    };
    let local: u8 = 0;
    let addr: usize = &local as *const u8 as usize;
    let counter: u32 = FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed_words: [u32; 4] = [
        nanos as u32,
        (nanos >> 32) as u32,
        (addr as u64) as u32 ^ ((addr as u64) >> 32) as u32,
        counter ^ std::process::id(),
    ];
    let mut state: [u32; 4] = [0; 4];
    for k in 0..4usize {
        let m = mix32(seed_words[k] ^ (k as u32).wrapping_mul(0x9E37_79B9));
        state[k] = m[k] ^ m[(k + 1) % 4];
    }
    if state == [0u32; 4] {
        state[0] = 1;
    }
    let mut rng = Rng::new(state);
    for b in buf.iter_mut() {
        *b = (rng.next_u32() >> 24) as u8;
    }
    buf
}

/// A uniformly random uint32 seed.
pub fn random_seed() -> u32 {
    let b = random_bytes(4);
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32.
pub fn ulid_at(now_ms: u64) -> String {
    let mut t: u64 = now_ms;
    let mut time: [u8; 10] = [b'0'; 10];
    for i in 0..10usize {
        time[9 - i] = CROCKFORD[(t % 32) as usize];
        t /= 32;
    }
    let rnd = random_bytes(16);
    let mut s = String::with_capacity(26);
    for &c in time.iter() {
        s.push(c as char);
    }
    for &r in rnd.iter() {
        s.push(CROCKFORD[(r & 31) as usize] as char);
    }
    s
}

pub fn ulid() -> String {
    let now_ms: u64 = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        Err(_) => 0,
    };
    ulid_at(now_ms)
}

pub fn is_ulid(s: &str) -> bool {
    if s.len() != 26 {
        return false;
    }
    s.bytes().all(|c| CROCKFORD.contains(&c))
}

pub fn generate_replay_code() -> String {
    let rnd = random_bytes(12);
    let alphabet = REPLAY_ALPHABET.as_bytes();
    let mut s = String::with_capacity(12);
    for &r in rnd.iter() {
        s.push(alphabet[(r & 31) as usize] as char);
    }
    format_replay_code(&s)
}

/// Upper-case and strip everything outside `[A-Z0-9]`; `None` if not a valid code.
pub fn normalize_replay_code(input: &str) -> Option<String> {
    let upper = input.to_uppercase();
    let s: String = upper
        .chars()
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .collect();
    if s.chars().count() != 12 {
        return None;
    }
    for ch in s.chars() {
        if !REPLAY_ALPHABET.contains(ch) {
            return None;
        }
    }
    Some(s)
}

/// `ABCDEFGHJKLM` -> `ABCD-EFGH-JKLM` (input must be ASCII).
pub fn format_replay_code(normalized: &str) -> String {
    let n = normalized.len();
    let a = &normalized[0..n.min(4)];
    let b = &normalized[n.min(4)..n.min(8)];
    let c = &normalized[n.min(8)..n.min(12)];
    format!("{}-{}-{}", a, b, c)
}
