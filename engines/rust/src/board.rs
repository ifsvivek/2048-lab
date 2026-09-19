//! SPEC §1–§3, §5 — board encoding, line merge, moves and spawning.
//! A board is 16 exponents, row-major (cell `i = row * 4 + col`).
use crate::rng::Rng;

pub type Board = [u8; 16];

pub const UP: usize = 0;
pub const DOWN: usize = 1;
pub const LEFT: usize = 2;
pub const RIGHT: usize = 3;

pub const DIRECTION_LETTERS: [char; 4] = ['U', 'D', 'L', 'R'];
pub const DIRECTION_NAMES: [&str; 4] = ["up", "down", "left", "right"];

/// `LINES[dir][line]` = the four cell indices, starting at the edge tiles slide toward.
pub const LINES: [[[usize; 4]; 4]; 4] = [
    // up
    [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]],
    // down
    [[12, 8, 4, 0], [13, 9, 5, 1], [14, 10, 6, 2], [15, 11, 7, 3]],
    // left
    [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]],
    // right
    [[3, 2, 1, 0], [7, 6, 5, 4], [11, 10, 9, 8], [15, 14, 13, 12]],
];

const HEX: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

pub fn empty_board() -> Board {
    [0u8; 16]
}

pub fn board_to_hex(board: &Board) -> String {
    let mut s = String::with_capacity(16);
    for &e in board.iter() {
        let idx = e as usize;
        let ch = if idx < HEX.len() { HEX[idx] as char } else { '?' };
        s.push(ch);
    }
    s
}

pub fn board_from_hex(hex: &str) -> Result<Board, String> {
    let chars: Vec<char> = hex.chars().collect();
    if chars.len() != 16 {
        return Err(format!("boardHex must be 16 chars, got {}", chars.len()));
    }
    let mut b: Board = [0u8; 16];
    for (i, ch) in chars.iter().enumerate() {
        let lower = ch.to_ascii_lowercase();
        let mut found: Option<u8> = None;
        for (k, &h) in HEX.iter().enumerate() {
            if (h as char) == lower {
                found = Some(k as u8);
                break;
            }
        }
        match found {
            Some(v) => b[i] = v,
            None => return Err(format!("invalid boardHex character '{}'", ch)),
        }
    }
    Ok(b)
}

/// Tile values (0 for empty) as a 4×4 matrix, `m[row][col]`.
pub fn board_to_matrix(board: &Board) -> Vec<Vec<u64>> {
    let mut m: Vec<Vec<u64>> = Vec::with_capacity(4);
    for r in 0..4usize {
        let mut row: Vec<u64> = Vec::with_capacity(4);
        for c in 0..4usize {
            let e = board[r * 4 + c];
            row.push(if e == 0 { 0 } else { 1u64 << (e as u32) });
        }
        m.push(row);
    }
    m
}

/// Inverse of `board_to_matrix`; every non-zero value must be a power of two >= 2.
pub fn board_from_matrix(m: &[Vec<u64>]) -> Result<Board, String> {
    if m.len() != 4 {
        return Err(String::from("board must have 4 rows"));
    }
    let mut b: Board = [0u8; 16];
    for r in 0..4usize {
        if m[r].len() != 4 {
            return Err(String::from("board rows must have 4 columns"));
        }
        for c in 0..4usize {
            let v = m[r][c];
            if v == 0 {
                continue;
            }
            if v < 2 || !v.is_power_of_two() {
                return Err(format!("invalid tile value {}", v));
            }
            b[r * 4 + c] = v.trailing_zeros() as u8;
        }
    }
    Ok(b)
}

pub fn max_exponent(board: &Board) -> u8 {
    let mut m: u8 = 0;
    for &e in board.iter() {
        if e > m {
            m = e;
        }
    }
    m
}

/// Largest tile value, 0 for an empty board.
pub fn max_tile(board: &Board) -> u64 {
    let e = max_exponent(board);
    if e == 0 {
        0
    } else {
        1u64 << (e as u32)
    }
}

pub fn empty_count(board: &Board) -> usize {
    board.iter().filter(|&&e| e == 0).count()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MoveResult {
    pub board: Board,
    pub gained: u64,
    pub changed: bool,
}

/// Apply `dir` to a copy of `board` (SPEC §3). If the move is invalid the
/// original board is returned with `changed = false` and `gained = 0`.
pub fn move_board(board: &Board, dir: usize) -> MoveResult {
    let mut out: Board = *board;
    let mut gained: u64 = 0;
    let mut changed = false;
    for line in LINES[dir].iter() {
        let mut tiles: [u8; 4] = [0; 4];
        let mut n: usize = 0;
        for &idx in line.iter() {
            let v = board[idx];
            if v != 0 {
                tiles[n] = v;
                n += 1;
            }
        }
        let mut res: [u8; 4] = [0; 4];
        let mut o: usize = 0;
        let mut i: usize = 0;
        while i < n {
            if i + 1 < n && tiles[i] == tiles[i + 1] {
                let e: u8 = tiles[i] + 1;
                res[o] = e;
                gained += 1u64 << (e as u32);
                i += 2;
            } else {
                res[o] = tiles[i];
                i += 1;
            }
            o += 1;
        }
        for k in 0..4usize {
            let idx = line[k];
            if out[idx] != res[k] {
                out[idx] = res[k];
                changed = true;
            }
        }
    }
    if changed {
        MoveResult { board: out, gained, changed: true }
    } else {
        MoveResult { board: *board, gained: 0, changed: false }
    }
}

pub fn can_move(board: &Board, dir: usize) -> bool {
    for line in LINES[dir].iter() {
        for k in 1..4usize {
            let prev = board[line[k - 1]];
            let cur = board[line[k]];
            if cur != 0 && (prev == 0 || prev == cur) {
                return true;
            }
        }
    }
    false
}

/// Directions that change the board, in canonical order.
pub fn valid_moves(board: &Board) -> Vec<usize> {
    let mut v: Vec<usize> = Vec::with_capacity(4);
    for d in 0..4usize {
        if can_move(board, d) {
            v.push(d);
        }
    }
    v
}

pub fn is_over(board: &Board) -> bool {
    for d in 0..4usize {
        if can_move(board, d) {
            return false;
        }
    }
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spawn {
    pub index: usize,
    pub exponent: u8,
}

/// SPEC §5. Returns the spawned tile, or `None` (without drawing) if the board is full.
pub fn spawn(board: &mut Board, rng: &mut Rng) -> Option<Spawn> {
    let mut empties: [usize; 16] = [0; 16];
    let mut n: usize = 0;
    for i in 0..16usize {
        if board[i] == 0 {
            empties[n] = i;
            n += 1;
        }
    }
    if n == 0 {
        return None;
    }
    let index = empties[rng.below(n as u64) as usize];
    let exponent: u8 = if rng.below(10) == 0 { 2 } else { 1 };
    board[index] = exponent;
    Some(Spawn { index, exponent })
}

/// Parse a direction from a name (`up`), a letter (`U`/`u`) or an index (`0`).
pub fn parse_direction(input: &str) -> Option<usize> {
    let s = input.trim().to_ascii_lowercase();
    for (i, name) in DIRECTION_NAMES.iter().enumerate() {
        if s == *name {
            return Some(i);
        }
    }
    match s.as_str() {
        "u" | "0" => Some(UP),
        "d" | "1" => Some(DOWN),
        "l" | "2" => Some(LEFT),
        "r" | "3" => Some(RIGHT),
        _ => None,
    }
}

pub fn direction_from_letter(ch: char) -> Option<usize> {
    match ch {
        'U' => Some(UP),
        'D' => Some(DOWN),
        'L' => Some(LEFT),
        'R' => Some(RIGHT),
        _ => None,
    }
}
