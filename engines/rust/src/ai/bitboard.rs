//! AI.md §1 — 64-bit bitboard: cell `i` occupies bits `4i .. 4i+3`, so row `r`
//! is the 16-bit value `(b >> 16r) & 0xFFFF` whose lowest nibble is column 0.
//! Rows use 65536-entry line tables directly; columns are handled by
//! transposing the board, applying the row tables, and transposing back.
use std::sync::OnceLock;

use crate::board::Board;

/// Line lookup tables (saturating: 15 + 15 = 15).
pub struct MoveTables {
    /// Slide toward the low nibble ("left" for rows, "up" for columns).
    pub toward_low: Vec<u16>,
    /// Slide toward the high nibble ("right" for rows, "down" for columns).
    pub toward_high: Vec<u16>,
}

fn reverse_line(v: u16) -> u16 {
    ((v & 0xF) << 12) | (((v >> 4) & 0xF) << 8) | (((v >> 8) & 0xF) << 4) | ((v >> 12) & 0xF)
}

fn merge_line_low(v: u16) -> u16 {
    let r: [u16; 4] = [v & 0xF, (v >> 4) & 0xF, (v >> 8) & 0xF, (v >> 12) & 0xF];
    let mut tiles: [u16; 4] = [0; 4];
    let mut n: usize = 0;
    for k in 0..4usize {
        if r[k] != 0 {
            tiles[n] = r[k];
            n += 1;
        }
    }
    let mut out: [u16; 4] = [0; 4];
    let mut o: usize = 0;
    let mut i: usize = 0;
    while i < n {
        if i + 1 < n && tiles[i] == tiles[i + 1] {
            let e = tiles[i] + 1;
            out[o] = if e > 15 { 15 } else { e };
            i += 2;
        } else {
            out[o] = tiles[i];
            i += 1;
        }
        o += 1;
    }
    out[0] | (out[1] << 4) | (out[2] << 8) | (out[3] << 12)
}

fn build_tables() -> MoveTables {
    let mut toward_low: Vec<u16> = vec![0u16; 65536];
    let mut toward_high: Vec<u16> = vec![0u16; 65536];
    for v in 0..65536usize {
        toward_low[v] = merge_line_low(v as u16);
    }
    for v in 0..65536usize {
        let rev = reverse_line(v as u16);
        toward_high[v] = reverse_line(toward_low[rev as usize]);
    }
    MoveTables {
        toward_low,
        toward_high,
    }
}

/// Process-wide move tables (built once).
pub fn move_tables() -> &'static MoveTables {
    static TABLES: OnceLock<MoveTables> = OnceLock::new();
    TABLES.get_or_init(build_tables)
}

/// Swap cell (r, c) with cell (c, r).
#[inline]
pub fn transpose(x: u64) -> u64 {
    let a1 = x & 0xF0F0_0F0F_F0F0_0F0F;
    let a2 = x & 0x0000_F0F0_0000_F0F0;
    let a3 = x & 0x0F0F_0000_0F0F_0000;
    let a = a1 | (a2 << 12) | (a3 >> 12);
    let b1 = a & 0xFF00_FF00_00FF_00FF;
    let b2 = a & 0x00FF_00FF_0000_0000;
    let b3 = a & 0x0000_0000_FF00_FF00;
    b1 | (b2 >> 24) | (b3 << 24)
}

#[inline]
fn apply_rows(b: u64, table: &[u16]) -> u64 {
    let r0 = table[(b & 0xFFFF) as usize] as u64;
    let r1 = table[((b >> 16) & 0xFFFF) as usize] as u64;
    let r2 = table[((b >> 32) & 0xFFFF) as usize] as u64;
    let r3 = table[((b >> 48) & 0xFFFF) as usize] as u64;
    r0 | (r1 << 16) | (r2 << 32) | (r3 << 48)
}

impl MoveTables {
    /// Apply direction `dir` (0 up, 1 down, 2 left, 3 right). The move changed
    /// the board iff the result differs from `b`.
    #[inline]
    pub fn apply(&self, b: u64, dir: usize) -> u64 {
        match dir {
            0 => transpose(apply_rows(transpose(b), &self.toward_low)),
            1 => transpose(apply_rows(transpose(b), &self.toward_high)),
            2 => apply_rows(b, &self.toward_low),
            _ => apply_rows(b, &self.toward_high),
        }
    }
}

/// Convenience wrapper using the global tables.
pub fn bb_move(b: u64, dir: usize) -> u64 {
    move_tables().apply(b, dir)
}

#[inline]
pub fn nibble(b: u64, i: usize) -> u8 {
    ((b >> (4 * i as u32)) & 0xF) as u8
}

/// Game board -> bitboard, clamping exponents above 15.
pub fn from_board(board: &Board) -> u64 {
    let mut b: u64 = 0;
    for i in 0..16usize {
        let e: u64 = if board[i] > 15 { 15 } else { board[i] as u64 };
        b |= e << (4 * i as u32);
    }
    b
}

pub fn to_board(b: u64) -> Board {
    let mut out: Board = [0u8; 16];
    for i in 0..16usize {
        out[i] = nibble(b, i);
    }
    out
}

/// Line value of column `c` (row 0 in the lowest nibble).
#[inline]
pub fn column(b: u64, c: usize) -> u16 {
    let s = (4 * c) as u32;
    let v0 = (b >> s) & 0xF;
    let v1 = (b >> (16 + s)) & 0xF;
    let v2 = (b >> (32 + s)) & 0xF;
    let v3 = (b >> (48 + s)) & 0xF;
    (v0 | (v1 << 4) | (v2 << 8) | (v3 << 12)) as u16
}

pub fn count_empty(b: u64) -> u32 {
    let mut n: u32 = 0;
    for i in 0..16u32 {
        if ((b >> (4 * i)) & 0xF) == 0 {
            n += 1;
        }
    }
    n
}

/// Number of distinct non-zero ranks on the board.
pub fn distinct_ranks(b: u64) -> u32 {
    let mut mask: u32 = 0;
    for i in 0..16u32 {
        let r = ((b >> (4 * i)) & 0xF) as u32;
        mask |= 1u32 << r;
    }
    mask &= !1u32;
    mask.count_ones()
}

pub fn max_rank(b: u64) -> u32 {
    let mut m: u32 = 0;
    for i in 0..16u32 {
        let r = ((b >> (4 * i)) & 0xF) as u32;
        if r > m {
            m = r;
        }
    }
    m
}
