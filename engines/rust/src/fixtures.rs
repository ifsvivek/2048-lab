//! Cross-language conformance: validates this engine against every file in
//! `spec/fixtures/`. Used by `g2048 validate` and by `tests/fixtures.rs`.
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ai::agents::{ExpectimaxAgent, RandomAgent};
use crate::ai::bitboard::{from_board, move_tables, to_board};
use crate::ai::expectimax::{ExpectimaxConfig, ExpectimaxSearch};
use crate::ai::heuristic::{evaluate, line_features, line_table, Weights};
use crate::bench::{play_game, run_suite, BenchmarkSuite};
use crate::board::{board_from_hex, board_to_hex, is_over, move_board, spawn, DIRECTION_LETTERS};
use crate::game::{Game, Snapshot};
use crate::hash::{board_hash, hash_hex, history_step, parse_hash_hex};
use crate::ids::{format_replay_code, normalize_replay_code};
use crate::replay::simulate;
use crate::rng::{mix32, Rng};

/// Fixture files, in validation order.
pub const FIXTURE_FILES: [&str; 9] = [
    "rng", "moves", "spawn", "hash", "games", "replays", "codes", "ai", "benchmarks",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub passed: usize,
    pub failed: usize,
    pub failures: Vec<String>,
}

impl Report {
    pub fn new() -> Report {
        Report::default()
    }

    fn record(&mut self, label: String, result: Result<(), String>) {
        match result {
            Ok(()) => self.passed += 1,
            Err(e) => {
                self.failed += 1;
                self.failures.push(format!("{}: {}", label, e));
            }
        }
    }

    pub fn merge(&mut self, other: Report) {
        self.passed += other.passed;
        self.failed += other.failed;
        self.failures.extend(other.failures);
    }

    pub fn ok(&self) -> bool {
        self.failed == 0
    }
}

// ------------------------------------------------------------ JSON helpers

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a Value, String> {
    match v.get(key) {
        Some(x) => Ok(x),
        None => Err(format!("missing field '{}'", key)),
    }
}

fn f_u64(v: &Value, key: &str) -> Result<u64, String> {
    match field(v, key)?.as_u64() {
        Some(x) => Ok(x),
        None => Err(format!("field '{}' is not an unsigned integer", key)),
    }
}

fn f_i64(v: &Value, key: &str) -> Result<i64, String> {
    match field(v, key)?.as_i64() {
        Some(x) => Ok(x),
        None => Err(format!("field '{}' is not an integer", key)),
    }
}

fn f_f64(v: &Value, key: &str) -> Result<f64, String> {
    match field(v, key)?.as_f64() {
        Some(x) => Ok(x),
        None => Err(format!("field '{}' is not a number", key)),
    }
}

fn f_bool(v: &Value, key: &str) -> Result<bool, String> {
    match field(v, key)?.as_bool() {
        Some(x) => Ok(x),
        None => Err(format!("field '{}' is not a boolean", key)),
    }
}

fn f_str<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    match field(v, key)?.as_str() {
        Some(x) => Ok(x),
        None => Err(format!("field '{}' is not a string", key)),
    }
}

fn f_arr<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    match field(v, key)?.as_array() {
        Some(x) => Ok(x),
        None => Err(format!("field '{}' is not an array", key)),
    }
}

fn f_state(v: &Value, key: &str) -> Result<[u32; 4], String> {
    let arr = f_arr(v, key)?;
    if arr.len() != 4 {
        return Err(format!("field '{}' must have 4 words", key));
    }
    let mut s: [u32; 4] = [0; 4];
    for k in 0..4usize {
        match arr[k].as_u64() {
            Some(x) if x <= 0xFFFF_FFFF => s[k] = x as u32,
            _ => return Err(format!("field '{}'[{}] is not a uint32", key, k)),
        }
    }
    Ok(s)
}

fn f_seed(v: &Value, key: &str) -> Result<u32, String> {
    let x = f_u64(v, key)?;
    if x > 0xFFFF_FFFF {
        return Err(format!("field '{}' is not a uint32", key));
    }
    Ok(x as u32)
}

fn expect_eq<T: PartialEq + std::fmt::Debug>(what: &str, actual: T, expected: T) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!("{}: expected {:?}, got {:?}", what, expected, actual))
    }
}

/// Relative float comparison (1e-9), exact for zero.
fn close(actual: f64, expected: f64) -> bool {
    if actual == expected {
        return true;
    }
    let scale = if expected.abs() > 1.0 { expected.abs() } else { 1.0 };
    (actual - expected).abs() <= 1e-9 * scale
}

fn expect_close(what: &str, actual: f64, expected: f64) -> Result<(), String> {
    if close(actual, expected) {
        Ok(())
    } else {
        Err(format!("{}: expected {}, got {}", what, expected, actual))
    }
}

fn letter_index(s: &str) -> Result<usize, String> {
    for (i, l) in DIRECTION_LETTERS.iter().enumerate() {
        if s.len() == 1 && s.starts_with(*l) {
            return Ok(i);
        }
    }
    Err(format!("bad direction letter '{}'", s))
}

fn compare_snapshot(snap: &Snapshot, expected: &Value) -> Result<(), String> {
    expect_eq("final.board", snap.board.as_str(), f_str(expected, "board")?)?;
    expect_eq("final.score", snap.score, f_u64(expected, "score")?)?;
    expect_eq("final.moveCount", snap.move_count, f_u64(expected, "moveCount")?)?;
    expect_eq("final.maxTile", snap.max_tile, f_u64(expected, "maxTile")?)?;
    expect_eq("final.over", snap.over, f_bool(expected, "over")?)?;
    expect_eq("final.historyHash", snap.history_hash.as_str(), f_str(expected, "historyHash")?)?;
    Ok(())
}

fn load(dir: &Path, name: &str) -> Result<Value, String> {
    let path: PathBuf = dir.join(format!("{}.json", name));
    let text = fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    serde_json::from_str(&text).map_err(|e| format!("cannot parse {}: {}", path.display(), e))
}

fn cases<'a>(doc: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    f_arr(doc, key)
}

// ------------------------------------------------------------ per-file checks

fn check_rng(doc: &Value, report: &mut Report) -> Result<(), String> {
    for (ci, c) in cases(doc, "cases")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let seed = f_seed(c, "seed")?;
            expect_eq("mix32 state", mix32(seed), f_state(c, "state")?)?;
            let mut rng = Rng::from_seed(seed);
            for (k, e) in f_arr(c, "next")?.iter().enumerate() {
                let want = e.as_u64().ok_or_else(|| String::from("next[] not an integer"))?;
                expect_eq(&format!("next[{}]", k), rng.next_u32() as u64, want)?;
            }
            let below = field(c, "below")?
                .as_object()
                .ok_or_else(|| String::from("below is not an object"))?;
            for (n_str, seq) in below.iter() {
                let n: u64 = n_str.parse().map_err(|_| format!("bad below key '{}'", n_str))?;
                let mut rb = Rng::from_seed(seed);
                let arr = seq.as_array().ok_or_else(|| String::from("below[n] not an array"))?;
                for (k, e) in arr.iter().enumerate() {
                    let want = e.as_u64().ok_or_else(|| String::from("below value not an integer"))?;
                    expect_eq(&format!("below({})[{}]", n, k), rb.below(n) as u64, want)?;
                }
            }
            Ok(())
        })();
        report.record(format!("rng#{}", ci), r);
    }
    Ok(())
}

fn check_moves(doc: &Value, report: &mut Report) -> Result<(), String> {
    for (ci, c) in cases(doc, "cases")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let hex = f_str(c, "board")?;
            let b = board_from_hex(hex)?;
            for res in f_arr(c, "results")?.iter() {
                let d = letter_index(f_str(res, "dir")?)?;
                let m = move_board(&b, d);
                let label = format!("{} {}", hex, DIRECTION_LETTERS[d]);
                expect_eq(&format!("{} board", label), board_to_hex(&m.board), f_str(res, "board")?.to_string())?;
                expect_eq(&format!("{} gained", label), m.gained, f_u64(res, "gained")?)?;
                expect_eq(&format!("{} changed", label), m.changed, f_bool(res, "changed")?)?;
            }
            expect_eq(&format!("{} over", hex), is_over(&b), f_bool(c, "over")?)?;
            Ok(())
        })();
        report.record(format!("moves#{}", ci), r);
    }
    Ok(())
}

fn check_spawn(doc: &Value, report: &mut Report) -> Result<(), String> {
    for (ci, c) in cases(doc, "cases")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let mut b = board_from_hex(f_str(c, "board")?)?;
            let mut rng = Rng::new(f_state(c, "rngState")?);
            let s = spawn(&mut b, &mut rng);
            expect_eq("result", board_to_hex(&b), f_str(c, "result")?.to_string())?;
            expect_eq("rngStateAfter", rng.state(), f_state(c, "rngStateAfter")?)?;
            let sv = field(c, "spawn")?;
            if sv.is_null() {
                if s.is_some() {
                    return Err(format!("expected no spawn, got {:?}", s));
                }
            } else {
                let got = s.ok_or_else(|| String::from("expected a spawn, got none"))?;
                expect_eq("spawn.index", got.index as u64, f_u64(sv, "index")?)?;
                expect_eq("spawn.exponent", got.exponent as u64, f_u64(sv, "exponent")?)?;
            }
            Ok(())
        })();
        report.record(format!("spawn#{}", ci), r);
    }
    Ok(())
}

fn check_hash(doc: &Value, report: &mut Report) -> Result<(), String> {
    for (ci, c) in cases(doc, "cases")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let b = board_from_hex(f_str(c, "board")?)?;
            expect_eq("boardHash", hash_hex(board_hash(&b)), f_str(c, "boardHash")?.to_string())?;
            let prev = parse_hash_hex(f_str(c, "prev")?).ok_or_else(|| String::from("bad prev hash"))?;
            let dir = f_u64(c, "dir")? as usize;
            expect_eq(
                "historyStep",
                hash_hex(history_step(prev, &b, dir)),
                f_str(c, "historyStep")?.to_string(),
            )?;
            Ok(())
        })();
        report.record(format!("hash#{}", ci), r);
    }
    Ok(())
}

fn check_games(doc: &Value, report: &mut Report) -> Result<(), String> {
    for (ci, c) in cases(doc, "newGames")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let g = Game::new(f_seed(c, "seed")?);
            expect_eq("board", board_to_hex(&g.board), f_str(c, "board")?.to_string())?;
            expect_eq("rngState", g.rng_state(), f_state(c, "rngState")?)?;
            expect_eq("historyHash", g.history_hash(), f_str(c, "historyHash")?.to_string())?;
            Ok(())
        })();
        report.record(format!("games.newGames#{}", ci), r);
    }
    for (ci, c) in cases(doc, "games")?.iter().enumerate() {
        let agent_name = c.get("agent").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let r = (|| -> Result<(), String> {
            let seed = f_seed(c, "seed")?;
            let moves = f_str(c, "moves")?;
            // Capped games carry "maxMoves"; absent or 0 means "play to completion".
            let max_moves: u64 = c.get("maxMoves").and_then(|x| x.as_u64()).unwrap_or(0);
            let game = simulate(seed, moves).map_err(|e| e.to_string())?;
            compare_snapshot(&game.snapshot(), field(c, "final")?)?;
            // Re-play the agent itself: it must choose exactly the recorded moves.
            let mut decisions: Vec<f64> = Vec::new();
            let replayed = match agent_name.as_str() {
                "random" => {
                    let mut a = RandomAgent::new();
                    Some(play_game(&mut a, seed, max_moves, false, &mut decisions)?)
                }
                "expectimax-d2" => {
                    let cfg = ExpectimaxConfig::from_json(&serde_json::json!({ "depth": 2 }))?;
                    let mut a = ExpectimaxAgent::new(cfg);
                    Some(play_game(&mut a, seed, max_moves, false, &mut decisions)?)
                }
                _ => None,
            };
            if let Some(out) = replayed {
                if out.game.moves() != moves {
                    let a: Vec<char> = out.game.moves().chars().collect();
                    let b: Vec<char> = moves.chars().collect();
                    let mut first = 0usize;
                    while first < a.len() && first < b.len() && a[first] == b[first] {
                        first += 1;
                    }
                    return Err(format!(
                        "agent '{}' replay diverged at move {} (got {} moves, expected {})",
                        agent_name,
                        first,
                        a.len(),
                        b.len()
                    ));
                }
            }
            Ok(())
        })();
        report.record(format!("games#{} ({})", ci, agent_name), r);
    }
    Ok(())
}

fn check_replays(doc: &Value, report: &mut Report) -> Result<(), String> {
    for (ci, c) in cases(doc, "cases")?.iter().enumerate() {
        let name = c.get("name").and_then(|x| x.as_str()).unwrap_or("?").to_string();
        let r = (|| -> Result<(), String> {
            let seed = f_seed(c, "seed")?;
            let moves = f_str(c, "moves")?;
            let expect = field(c, "expect")?;
            let ok = f_bool(expect, "ok")?;
            match simulate(seed, moves) {
                Ok(game) => {
                    if !ok {
                        return Err(format!("expected error {:?}, replay succeeded", expect.get("error")));
                    }
                    compare_snapshot(&game.snapshot(), field(expect, "final")?)
                }
                Err(e) => {
                    if ok {
                        return Err(format!("expected success, got {}", e));
                    }
                    expect_eq("error", e.code.as_str(), f_str(expect, "error")?)?;
                    if let Some(mi) = expect.get("moveIndex").and_then(|x| x.as_u64()) {
                        expect_eq("moveIndex", e.move_index.map(|x| x as u64), Some(mi))?;
                    }
                    Ok(())
                }
            }
        })();
        report.record(format!("replays#{} ({})", ci, name), r);
    }
    Ok(())
}

fn check_codes(doc: &Value, report: &mut Report) -> Result<(), String> {
    for (ci, c) in cases(doc, "cases")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let input = f_str(c, "input")?;
            let normalized = normalize_replay_code(input);
            let want_norm: Option<String> = field(c, "normalized")?.as_str().map(|s| s.to_string());
            expect_eq(&format!("normalize({:?})", input), normalized.clone(), want_norm)?;
            let formatted: Option<String> = normalized.as_ref().map(|n| format_replay_code(n));
            let want_fmt: Option<String> = field(c, "formatted")?.as_str().map(|s| s.to_string());
            expect_eq(&format!("format({:?})", input), formatted, want_fmt)?;
            Ok(())
        })();
        report.record(format!("codes#{}", ci), r);
    }
    Ok(())
}

fn check_ai(doc: &Value, report: &mut Report) -> Result<(), String> {
    let weights = field(doc, "weights")?;
    let canonical_w = Weights::from_json(field(weights, "canonical")?)?;
    let all_w = Weights::from_json(field(weights, "allWeights")?)?;
    let canonical_t = line_table(&canonical_w);
    let all_t = line_table(&all_w);

    for (ci, c) in cases(doc, "lines")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let v = f_u64(c, "line")?;
            if v > 0xFFFF {
                return Err(format!("line {} out of range", v));
            }
            let f = line_features(v as u16);
            let fe = field(c, "features")?;
            expect_eq("empty", f.empty, f_i64(fe, "empty")?)?;
            expect_eq("merges", f.merges, f_i64(fe, "merges")?)?;
            expect_eq("mono", f.mono, f_i64(fe, "mono")?)?;
            expect_eq("sum", f.sum, f_i64(fe, "sum")?)?;
            expect_eq("smooth", f.smooth, f_i64(fe, "smooth")?)?;
            expect_eq("stable", f.stable, f_i64(fe, "stable")?)?;
            expect_close("canonical", canonical_t[v as usize], f_f64(c, "canonical")?)?;
            expect_close("allWeights", all_t[v as usize], f_f64(c, "allWeights")?)?;
            Ok(())
        })();
        report.record(format!("ai.lines#{}", ci), r);
    }

    for (ci, c) in cases(doc, "evaluations")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let b = from_board(&board_from_hex(f_str(c, "board")?)?);
            expect_close("canonical", evaluate(b, &canonical_t, canonical_w.corner), f_f64(c, "canonical")?)?;
            expect_close("allWeights", evaluate(b, &all_t, all_w.corner), f_f64(c, "allWeights")?)?;
            Ok(())
        })();
        report.record(format!("ai.evaluations#{}", ci), r);
    }

    let tables = move_tables();
    for (ci, c) in cases(doc, "bitboardMoves")?.iter().enumerate() {
        let r = (|| -> Result<(), String> {
            let b = from_board(&board_from_hex(f_str(c, "board")?)?);
            for (d, res) in f_arr(c, "results")?.iter().enumerate() {
                if d > 3 {
                    return Err(String::from("more than 4 results"));
                }
                let nb = tables.apply(b, d);
                expect_eq(&format!("dir {} changed", d), nb != b, f_bool(res, "changed")?)?;
                expect_eq(
                    &format!("dir {} board", d),
                    board_to_hex(&to_board(nb)),
                    f_str(res, "board")?.to_string(),
                )?;
            }
            Ok(())
        })();
        report.record(format!("ai.bitboardMoves#{}", ci), r);
    }

    for (ci, c) in cases(doc, "searches")?.iter().enumerate() {
        let profile = c.get("profile").and_then(|x| x.as_str()).unwrap_or("?").to_string();
        let r = (|| -> Result<(), String> {
            let hex = f_str(c, "board")?;
            let b = from_board(&board_from_hex(hex)?);
            let cfg = ExpectimaxConfig::from_json(field(c, "config")?)?;
            let mut s = ExpectimaxSearch::new(cfg);
            let res = s.search(b);
            let want_move: Option<usize> = match field(c, "move")?.as_str() {
                Some(l) => Some(letter_index(l)?),
                None => None,
            };
            expect_eq("move", res.mv, want_move)?;
            expect_eq("depth", res.depth as u64, f_u64(c, "depth")?)?;
            let vals = f_arr(c, "values")?;
            if vals.len() != 4 {
                return Err(String::from("values must have 4 entries"));
            }
            for d in 0..4usize {
                match (res.values[d], vals[d].as_f64()) {
                    (None, None) => {
                        if !vals[d].is_null() {
                            return Err(format!("values[{}] is neither number nor null", d));
                        }
                    }
                    (Some(a), Some(e)) => expect_close(&format!("values[{}]", d), a, e)?,
                    (a, _) => {
                        return Err(format!("values[{}]: expected {}, got {:?}", d, vals[d], a));
                    }
                }
            }
            Ok(())
        })();
        report.record(format!("ai.searches#{} ({})", ci, profile), r);
    }
    Ok(())
}

fn check_benchmarks(doc: &Value, dir: &Path, report: &mut Report) -> Result<(), String> {
    let suites = field(doc, "suites")?
        .as_object()
        .ok_or_else(|| String::from("suites is not an object"))?;
    let bench_dir = dir.join("..").join("benchmarks");
    for (id, expected) in suites.iter() {
        let r = (|| -> Result<(), String> {
            let suite = BenchmarkSuite::load(&bench_dir.join(format!("{}.json", id)))?;
            let res = run_suite(&suite)?;
            expect_eq("checksum", res.checksum.as_str(), f_str(expected, "checksum")?)?;
            expect_eq("games", res.summary.games, f_u64(expected, "games")?)?;
            expect_eq("totalMoves", res.summary.total_moves, f_u64(expected, "totalMoves")?)?;
            expect_eq("totalScore", res.total_score(), f_u64(expected, "totalScore")?)?;
            expect_eq("maxScore", res.summary.max_score, f_u64(expected, "maxScore")?)?;
            Ok(())
        })();
        report.record(format!("benchmarks.{}", id), r);
    }
    Ok(())
}

/// Validate one fixture file (`name` without `.json`, e.g. `"rng"`).
pub fn validate_named(dir: &Path, name: &str) -> Report {
    let mut report = Report::new();
    let doc = match load(dir, name) {
        Ok(d) => d,
        Err(e) => {
            report.record(name.to_string(), Err(e));
            return report;
        }
    };
    let result = match name {
        "rng" => check_rng(&doc, &mut report),
        "moves" => check_moves(&doc, &mut report),
        "spawn" => check_spawn(&doc, &mut report),
        "hash" => check_hash(&doc, &mut report),
        "games" => check_games(&doc, &mut report),
        "replays" => check_replays(&doc, &mut report),
        "codes" => check_codes(&doc, &mut report),
        "ai" => check_ai(&doc, &mut report),
        "benchmarks" => check_benchmarks(&doc, dir, &mut report),
        other => Err(format!("unknown fixture file '{}'", other)),
    };
    if let Err(e) = result {
        report.record(format!("{} (structure)", name), Err(e));
    }
    report
}

/// Validate every fixture file.
pub fn validate_all(dir: &Path) -> Report {
    let mut report = Report::new();
    for name in FIXTURE_FILES.iter() {
        report.merge(validate_named(dir, name));
    }
    report
}

