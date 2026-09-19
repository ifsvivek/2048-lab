//! Rust port of the canonical 2048 engine (spec/SPEC.md) and the canonical
//! expectimax agent (spec/AI.md). Every observable behaviour is pinned down by
//! the shared fixtures in `spec/fixtures/`; see `fixtures::validate_all`.

pub mod ai;
pub mod bench;
pub mod board;
pub mod fixtures;
pub mod game;
pub mod hash;
pub mod ids;
pub mod replay;
pub mod rng;
pub mod server;

/// Version of this engine implementation (reported in benchmark results).
pub const ENGINE_VERSION: &str = "1.0.0";

/// Compiler version captured by build.rs, or "unknown".
pub fn runtime_version() -> &'static str {
    match option_env!("RUSTC_VERSION") {
        Some(v) => v,
        None => "unknown",
    }
}

/// Default location of the shared fixtures, relative to this crate.
pub const DEFAULT_FIXTURES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/fixtures");
