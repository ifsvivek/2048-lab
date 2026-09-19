//! Canonical expectimax AI (spec/AI.md) and the built-in agents.

pub mod agents;
pub mod bitboard;
pub mod expectimax;
pub mod heuristic;

pub use agents::{create_agent, Agent, Decision, DecisionMetrics, ExpectimaxAgent, GreedyAgent, RandomAgent};
pub use bitboard::{distinct_ranks, from_board, move_tables, to_board, transpose, MoveTables};
pub use expectimax::{DepthSetting, ExpectimaxConfig, ExpectimaxSearch, SearchResult};
pub use heuristic::{line_features, line_table, Breakdown, LineFeatures, Weights, HEURISTIC_V1};
