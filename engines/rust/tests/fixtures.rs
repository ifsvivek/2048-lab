//! Conformance with the shared cross-language fixtures (spec/fixtures/*.json).
//! Run with `cargo test --release` — the benchmark fixtures replay full
//! expectimax games and are slow in debug builds.
use std::path::PathBuf;

use g2048::fixtures::validate_named;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(g2048::DEFAULT_FIXTURES_DIR)
}

fn run(name: &str) {
    let report = validate_named(&fixtures_dir(), name);
    assert!(
        report.failed == 0,
        "{}.json: {} passed, {} failed:\n{}",
        name,
        report.passed,
        report.failed,
        report.failures.join("\n")
    );
    assert!(report.passed > 0, "{}.json: no cases were checked", name);
}

#[test]
fn rng() {
    run("rng");
}

#[test]
fn moves() {
    run("moves");
}

#[test]
fn spawn() {
    run("spawn");
}

#[test]
fn hash() {
    run("hash");
}

#[test]
fn games() {
    run("games");
}

#[test]
fn replays() {
    run("replays");
}

#[test]
fn codes() {
    run("codes");
}

#[test]
fn ai() {
    run("ai");
}

#[test]
fn benchmarks() {
    run("benchmarks");
}

#[test]
fn replay_error_codes_and_verification() {
    use g2048::replay::{verify_replay, ClaimedFinal, ReplayErrorCode};
    let err = verify_replay(2, 1, "", None).unwrap_err();
    assert_eq!(err.code, ReplayErrorCode::SpecVersion);

    let snap = verify_replay(1, 77, "LURD", None).expect("valid replay");
    let claimed = ClaimedFinal {
        score: Some(snap.score + 4),
        ..ClaimedFinal::default()
    };
    let err = verify_replay(1, 77, "LURD", Some(&claimed)).unwrap_err();
    assert_eq!(err.code, ReplayErrorCode::FinalMismatch);

    let ok = ClaimedFinal {
        board: Some(snap.board.clone()),
        score: Some(snap.score),
        move_count: Some(snap.move_count),
        history_hash: Some(snap.history_hash.clone()),
    };
    assert_eq!(verify_replay(1, 77, "LURD", Some(&ok)).unwrap(), snap);
}

#[test]
fn iso_timestamps() {
    use g2048::bench::{civil_from_days, iso_from_millis};
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(civil_from_days(-1), (1969, 12, 31));
    assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_from_millis(1_758_283_200_123), "2025-09-19T12:00:00.123Z");
}

#[test]
fn ids() {
    use g2048::ids::{generate_replay_code, is_ulid, normalize_replay_code, ulid};
    let id = ulid();
    assert_eq!(id.len(), 26);
    assert!(is_ulid(&id));
    let code = generate_replay_code();
    assert_eq!(code.len(), 14);
    assert!(normalize_replay_code(&code).is_some());
}

#[test]
fn transpose_is_an_involution() {
    use g2048::ai::bitboard::{from_board, to_board, transpose};
    let b = g2048::board::board_from_hex("0123456789abcdef").unwrap();
    let x = from_board(&b);
    let t = to_board(transpose(x));
    for r in 0..4 {
        for c in 0..4 {
            assert_eq!(t[r * 4 + c], b[c * 4 + r]);
        }
    }
    assert_eq!(transpose(transpose(x)), x);
}

/// Reference TT policy (spec/AI.md §3): node, hit and size counts must match
/// the TypeScript reference exactly, including table persistence across
/// searches and clearing at >75 % occupancy. Expected values were produced by
/// packages/engine/src/ai/expectimax.ts.
#[test]
fn reference_tt_policy_node_counts() {
    use g2048::ai::bitboard::from_board;
    use g2048::ai::expectimax::{ExpectimaxConfig, ExpectimaxSearch};
    use g2048::board::board_from_hex;
    let boards = [
        "1024023713480379",
        "a0a473a03a594190",
        "209080aa2a531140",
        "0000000110000000",
        "1234432112344321",
    ];
    let cases: [(&str, [[u64; 3]; 5]); 3] = [
        (
            r#"{"depth":2}"#,
            [[599, 48, 65], [593, 30, 138], [1107, 41, 244], [2820, 340, 332], [0, 0, 332]],
        ),
        (
            r#"{"depth":3}"#,
            [[8030, 764, 886], [7246, 584, 1884], [16351, 1778, 3439], [27648, 8234, 4165], [0, 0, 4165]],
        ),
        (
            r#"{"depth":2,"ttBits":8}"#,
            [[599, 48, 65], [593, 30, 125], [1143, 38, 191], [3228, 325, 225], [0, 0, 0]],
        ),
    ];
    for (cfg_text, expected) in cases.iter() {
        let cfg_json: serde_json::Value = serde_json::from_str(cfg_text).unwrap();
        let cfg = ExpectimaxConfig::from_json(&cfg_json).unwrap();
        let mut search = ExpectimaxSearch::new(cfg);
        for (i, hex) in boards.iter().enumerate() {
            let b = from_board(&board_from_hex(hex).unwrap());
            let r = search.search(b);
            assert_eq!(
                [r.nodes, r.tt_hits, r.tt_size],
                expected[i],
                "config {} board {}",
                cfg_text,
                hex
            );
        }
    }
}
