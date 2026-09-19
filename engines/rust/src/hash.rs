//! SPEC §7 — FNV-1a 32-bit board and history hashes.
use crate::board::Board;

pub const FNV_OFFSET: u32 = 0x811C_9DC5;
pub const FNV_PRIME: u32 = 0x0100_0193;

/// FNV-1a over a byte sequence, starting from `h`.
pub fn fnv1a32_from(bytes: &[u8], h: u32) -> u32 {
    let mut x: u32 = h;
    for &b in bytes.iter() {
        x = (x ^ (b as u32)).wrapping_mul(FNV_PRIME);
    }
    x
}

pub fn fnv1a32(bytes: &[u8]) -> u32 {
    fnv1a32_from(bytes, FNV_OFFSET)
}

pub fn board_hash(board: &Board) -> u32 {
    fnv1a32(&board[..])
}

/// `h' = fnv1a32(le32(h) ++ board ++ [dir])`
pub fn history_step(h: u32, board: &Board, dir: usize) -> u32 {
    let mut bytes: [u8; 21] = [0; 21];
    bytes[0..4].copy_from_slice(&h.to_le_bytes());
    bytes[4..20].copy_from_slice(&board[..]);
    bytes[20] = dir as u8;
    fnv1a32(&bytes[..])
}

/// Lowercase 8-digit hex.
pub fn hash_hex(h: u32) -> String {
    format!("{:08x}", h)
}

/// Parse an 8-digit hex hash.
pub fn parse_hash_hex(s: &str) -> Option<u32> {
    u32::from_str_radix(s, 16).ok()
}
