//! SPEC §8 — replay verification and history reconstruction.
use std::fmt;

use serde_json::Value;

use crate::board::{direction_from_letter, Board, Spawn};
use crate::game::{Game, Snapshot, SPEC_VERSION};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayErrorCode {
    InvalidMoveAt,
    BadLetter,
    SpecVersion,
    FinalMismatch,
}

impl ReplayErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReplayErrorCode::InvalidMoveAt => "INVALID_MOVE_AT",
            ReplayErrorCode::BadLetter => "BAD_LETTER",
            ReplayErrorCode::SpecVersion => "SPEC_VERSION",
            ReplayErrorCode::FinalMismatch => "FINAL_MISMATCH",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayError {
    pub code: ReplayErrorCode,
    pub move_index: Option<usize>,
    pub message: String,
}

impl ReplayError {
    fn new(code: ReplayErrorCode, message: String, move_index: Option<usize>) -> ReplayError {
        ReplayError {
            code,
            move_index,
            message,
        }
    }
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ReplayError {}

pub fn letter_to_direction(ch: char, at: usize) -> Result<usize, ReplayError> {
    match direction_from_letter(ch) {
        Some(d) => Ok(d),
        None => Err(ReplayError::new(
            ReplayErrorCode::BadLetter,
            format!("bad move letter '{}' at {}", ch, at),
            Some(at),
        )),
    }
}

/// Re-simulate `moves` from `seed`.
pub fn simulate(seed: u32, moves: &str) -> Result<Game, ReplayError> {
    let mut game = Game::new(seed);
    for (i, ch) in moves.chars().enumerate() {
        let dir = letter_to_direction(ch, i)?;
        if game.apply(dir).is_none() {
            return Err(ReplayError::new(
                ReplayErrorCode::InvalidMoveAt,
                format!("INVALID_MOVE_AT {}", i),
                Some(i),
            ));
        }
    }
    Ok(game)
}

/// Claimed final state of a replay; absent fields are not checked.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaimedFinal {
    pub board: Option<String>,
    pub score: Option<u64>,
    pub move_count: Option<u64>,
    pub history_hash: Option<String>,
}

impl ClaimedFinal {
    pub fn from_json(v: &Value) -> ClaimedFinal {
        ClaimedFinal {
            board: v.get("board").and_then(|x| x.as_str()).map(|s| s.to_string()),
            score: v.get("score").and_then(|x| x.as_u64()),
            move_count: v.get("moveCount").and_then(|x| x.as_u64()),
            history_hash: v
                .get("historyHash")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
        }
    }
}

fn mismatch(key: &str, claimed: String, actual: String) -> ReplayError {
    ReplayError::new(
        ReplayErrorCode::FinalMismatch,
        format!("final.{} mismatch: claimed {}, actual {}", key, claimed, actual),
        None,
    )
}

/// Verify a replay; returns the authoritative final snapshot.
pub fn verify_replay(
    spec_version: u64,
    seed: u32,
    moves: &str,
    claimed: Option<&ClaimedFinal>,
) -> Result<Snapshot, ReplayError> {
    if spec_version != SPEC_VERSION {
        return Err(ReplayError::new(
            ReplayErrorCode::SpecVersion,
            format!("unsupported specVersion {}", spec_version),
            None,
        ));
    }
    let snap = simulate(seed, moves)?.snapshot();
    if let Some(f) = claimed {
        if let Some(b) = &f.board {
            if *b != snap.board {
                return Err(mismatch("board", b.clone(), snap.board.clone()));
            }
        }
        if let Some(s) = f.score {
            if s != snap.score {
                return Err(mismatch("score", s.to_string(), snap.score.to_string()));
            }
        }
        if let Some(m) = f.move_count {
            if m != snap.move_count {
                return Err(mismatch("moveCount", m.to_string(), snap.move_count.to_string()));
            }
        }
        if let Some(h) = &f.history_hash {
            if *h != snap.history_hash {
                return Err(mismatch("historyHash", h.clone(), snap.history_hash.clone()));
            }
        }
    }
    Ok(snap)
}

/// Verify a replay given as JSON (SPEC §8 shape).
pub fn verify_replay_json(replay: &Value) -> Result<Snapshot, ReplayError> {
    let spec_version = replay.get("specVersion").and_then(|x| x.as_u64()).unwrap_or(0);
    let seed = replay.get("seed").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let moves = replay.get("moves").and_then(|x| x.as_str()).unwrap_or("");
    let claimed = replay.get("final").map(ClaimedFinal::from_json);
    verify_replay(spec_version, seed, moves, claimed.as_ref())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryFrame {
    pub board: Board,
    pub score: u64,
    /// move that produced this frame (`None` for the initial frame)
    pub dir: Option<usize>,
    pub gained: u64,
    pub spawn: Option<Spawn>,
}

/// Full board history — frame 0 is the initial board, frame k follows move k.
pub fn reconstruct(seed: u32, moves: &str) -> Result<Vec<HistoryFrame>, ReplayError> {
    let mut game = Game::new(seed);
    let mut frames: Vec<HistoryFrame> = Vec::with_capacity(moves.len() + 1);
    frames.push(HistoryFrame {
        board: game.board,
        score: 0,
        dir: None,
        gained: 0,
        spawn: None,
    });
    for (i, ch) in moves.chars().enumerate() {
        let dir = letter_to_direction(ch, i)?;
        match game.apply(dir) {
            Some(step) => frames.push(HistoryFrame {
                board: game.board,
                score: game.score,
                dir: Some(dir),
                gained: step.gained,
                spawn: step.spawn,
            }),
            None => {
                return Err(ReplayError::new(
                    ReplayErrorCode::InvalidMoveAt,
                    format!("INVALID_MOVE_AT {}", i),
                    Some(i),
                ))
            }
        }
    }
    Ok(frames)
}
