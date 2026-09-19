//! SPEC §6 — the game lifecycle.
use serde::Serialize;

use crate::board::{
    board_to_hex, is_over, max_tile, move_board, spawn, Board, Spawn, DIRECTION_LETTERS,
};
use crate::hash::{board_hash, hash_hex, history_step};
use crate::rng::Rng;

pub const SPEC_VERSION: u64 = 1;

/// Serialisable game state (the replay `final` object).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub board: String,
    pub score: u64,
    pub move_count: u64,
    pub max_tile: u64,
    pub over: bool,
    pub history_hash: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
    pub dir: usize,
    pub gained: u64,
    pub spawn: Option<Spawn>,
}

#[derive(Clone, Debug)]
pub struct Game {
    pub seed: u32,
    pub board: Board,
    pub score: u64,
    pub move_count: u64,
    rng: Rng,
    hash: u32,
    moves: String,
}

impl Game {
    pub fn new(seed: u32) -> Game {
        let mut rng = Rng::from_seed(seed);
        let mut board: Board = [0u8; 16];
        spawn(&mut board, &mut rng);
        spawn(&mut board, &mut rng);
        let hash = board_hash(&board);
        Game {
            seed,
            board,
            score: 0,
            move_count: 0,
            rng,
            hash,
            moves: String::new(),
        }
    }

    /// Apply a move. Returns `None` (and changes nothing) if the move is invalid.
    pub fn apply(&mut self, dir: usize) -> Option<Step> {
        if dir > 3 {
            return None;
        }
        let r = move_board(&self.board, dir);
        if !r.changed {
            return None;
        }
        self.board = r.board;
        self.score += r.gained;
        self.move_count += 1;
        let s = spawn(&mut self.board, &mut self.rng);
        self.hash = history_step(self.hash, &self.board, dir);
        self.moves.push(DIRECTION_LETTERS[dir]);
        Some(Step {
            dir,
            gained: r.gained,
            spawn: s,
        })
    }

    pub fn over(&self) -> bool {
        is_over(&self.board)
    }

    pub fn history_hash_value(&self) -> u32 {
        self.hash
    }

    pub fn history_hash(&self) -> String {
        hash_hex(self.hash)
    }

    /// One letter per applied move.
    pub fn moves(&self) -> &str {
        &self.moves
    }

    pub fn rng_state(&self) -> [u32; 4] {
        self.rng.state()
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            board: board_to_hex(&self.board),
            score: self.score,
            move_count: self.move_count,
            max_tile: max_tile(&self.board),
            over: self.over(),
            history_hash: self.history_hash(),
        }
    }
}
