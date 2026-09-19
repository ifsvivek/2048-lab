//! The common agent interface and the built-in agents (random, greedy, expectimax).
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;

use super::bitboard::{from_board, move_tables};
use super::expectimax::{ExpectimaxConfig, ExpectimaxSearch};
use super::heuristic::Breakdown;
use crate::board::{valid_moves, Board};
use crate::rng::Rng;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionMetrics {
    pub time_us: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nodes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tt_hits: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tt_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<[Option<f64>; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heuristic: Option<Breakdown>,
    pub deterministic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_depths: Option<Vec<u32>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    /// direction index (0 up, 1 down, 2 left, 3 right)
    pub mv: usize,
    pub metrics: DecisionMetrics,
}

/// Given an observation, return a direction.
pub trait Agent {
    /// Short builtin id: "random", "greedy" or "expectimax".
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn version(&self) -> &str {
        "1.0.0"
    }
    /// Effective configuration, if the agent has one.
    fn config(&self) -> Option<Value> {
        None
    }
    /// Called once per game before the first decision.
    fn reset(&mut self, _seed: u32) {}
    /// Return a move. Only called when at least one move is valid.
    fn decide(&mut self, board: &Board) -> Decision;
}

fn micros_since(t: Instant) -> u64 {
    ((t.elapsed().as_nanos() + 500) / 1000) as u64
}

/// SPEC §10 reference random agent.
pub struct RandomAgent {
    rng: Rng,
}

impl RandomAgent {
    pub fn new() -> RandomAgent {
        RandomAgent { rng: Rng::from_seed(0) }
    }
}

impl Default for RandomAgent {
    fn default() -> RandomAgent {
        RandomAgent::new()
    }
}

impl Agent for RandomAgent {
    fn id(&self) -> &str {
        "random"
    }
    fn name(&self) -> &str {
        "Random"
    }
    fn reset(&mut self, seed: u32) {
        self.rng = Rng::from_seed(seed ^ 0xA5A5_A5A5);
    }
    fn decide(&mut self, board: &Board) -> Decision {
        let t = Instant::now();
        let valid = valid_moves(board);
        let mv = if valid.is_empty() {
            0
        } else {
            valid[self.rng.below(valid.len() as u64) as usize]
        };
        Decision {
            mv,
            metrics: DecisionMetrics {
                time_us: micros_since(t),
                deterministic: true,
                ..DecisionMetrics::default()
            },
        }
    }
}

/// One-ply greedy: maximise empty cells after the move, ties to the lower direction.
pub struct GreedyAgent;

impl GreedyAgent {
    pub fn new() -> GreedyAgent {
        GreedyAgent
    }
}

impl Default for GreedyAgent {
    fn default() -> GreedyAgent {
        GreedyAgent::new()
    }
}

impl Agent for GreedyAgent {
    fn id(&self) -> &str {
        "greedy"
    }
    fn name(&self) -> &str {
        "Greedy"
    }
    fn decide(&mut self, board: &Board) -> Decision {
        let t = Instant::now();
        let tables = move_tables();
        let b = from_board(board);
        let valid = valid_moves(board);
        let mut best: usize = if valid.is_empty() { 0 } else { valid[0] };
        let mut best_score: i32 = -1;
        for d in 0..4usize {
            let nb = tables.apply(b, d);
            if nb == b {
                continue;
            }
            let mut empty: i32 = 0;
            for i in 0..16u32 {
                if ((nb >> (4 * i)) & 0xF) == 0 {
                    empty += 1;
                }
            }
            if empty > best_score {
                best_score = empty;
                best = d;
            }
        }
        Decision {
            mv: best,
            metrics: DecisionMetrics {
                time_us: micros_since(t),
                deterministic: true,
                ..DecisionMetrics::default()
            },
        }
    }
}

/// Canonical expectimax (spec/AI.md).
pub struct ExpectimaxAgent {
    pub search: ExpectimaxSearch,
}

impl ExpectimaxAgent {
    pub fn new(config: ExpectimaxConfig) -> ExpectimaxAgent {
        ExpectimaxAgent {
            search: ExpectimaxSearch::new(config),
        }
    }
}

impl Agent for ExpectimaxAgent {
    fn id(&self) -> &str {
        "expectimax"
    }
    fn name(&self) -> &str {
        "Expectimax"
    }
    fn config(&self) -> Option<Value> {
        Some(self.search.config.to_json())
    }
    fn decide(&mut self, board: &Board) -> Decision {
        let b = from_board(board);
        let r = self.search.search(b);
        let mv = match r.mv {
            Some(d) => d,
            None => {
                let valid = valid_moves(board);
                if valid.is_empty() {
                    0
                } else {
                    valid[0]
                }
            }
        };
        let heuristic = self.search.breakdown(b);
        Decision {
            mv,
            metrics: DecisionMetrics {
                time_us: r.time_us,
                depth: Some(r.depth),
                nodes: Some(r.nodes),
                tt_hits: Some(r.tt_hits),
                tt_size: Some(r.tt_size),
                values: Some(r.values),
                heuristic: Some(heuristic),
                deterministic: r.deterministic,
                completed_depths: Some(r.completed_depths),
            },
        }
    }
}

/// Build a builtin agent by id (`random`, `greedy`, `expectimax`, optionally
/// prefixed with `builtin/`). `config` applies to expectimax only.
pub fn create_agent(id: &str, config: Option<&Value>) -> Result<Box<dyn Agent + Send>, String> {
    let short = id.strip_prefix("builtin/").unwrap_or(id);
    match short {
        "random" => Ok(Box::new(RandomAgent::new())),
        "greedy" => Ok(Box::new(GreedyAgent::new())),
        "expectimax" => {
            let cfg = match config {
                Some(v) => ExpectimaxConfig::from_json(v)?,
                None => ExpectimaxConfig::default(),
            };
            Ok(Box::new(ExpectimaxAgent::new(cfg)))
        }
        other => Err(format!("unknown agent '{}' (expected random, greedy or expectimax)", other)),
    }
}
