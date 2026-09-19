//! `g2048` command-line interface (hand-parsed arguments).
use std::fs;
use std::path::PathBuf;
use std::process;

use serde_json::{json, Map, Value};

use g2048::ai::agents::{create_agent, Agent};
use g2048::bench::{play_game, run_suite_with, BenchmarkSuite, GameResult};
use g2048::fixtures::validate_all;
use g2048::game::SPEC_VERSION;
use g2048::ids::random_seed;
use g2048::server::{serve, ServerConfig};

const USAGE: &str = "g2048 — Rust port of the canonical 2048 engine and AI

USAGE:
  g2048 validate [--fixtures PATH] [--json]
  g2048 bench --suite PATH [--out FILE] [--quiet]
  g2048 play [--seed N] [--agent random|greedy|expectimax] [--depth auto|N]
             [--time-budget-ms N] [--max-moves N] [--out FILE]
  g2048 serve [--addr 0.0.0.0:8080] [--agent expectimax] [--depth auto|N]
              [--time-budget-ms N]
  g2048 help
";

/// Parsed `--flag value` / `--flag` arguments.
struct Args {
    values: Vec<(String, Option<String>)>,
}

/// Flags that never take a value.
const BOOLEAN_FLAGS: [&str; 3] = ["--json", "--quiet", "--help"];

impl Args {
    fn parse(raw: &[String]) -> Result<Args, String> {
        let mut values: Vec<(String, Option<String>)> = Vec::new();
        let mut i = 0usize;
        while i < raw.len() {
            let a = &raw[i];
            if !a.starts_with("--") {
                return Err(format!("unexpected argument '{}'", a));
            }
            if let Some(eq) = a.find('=') {
                values.push((a[..eq].to_string(), Some(a[eq + 1..].to_string())));
                i += 1;
                continue;
            }
            if BOOLEAN_FLAGS.contains(&a.as_str()) {
                values.push((a.clone(), None));
                i += 1;
                continue;
            }
            if i + 1 >= raw.len() {
                return Err(format!("flag {} requires a value", a));
            }
            values.push((a.clone(), Some(raw[i + 1].clone())));
            i += 2;
        }
        Ok(Args { values })
    }

    fn has(&self, flag: &str) -> bool {
        self.values.iter().any(|(k, _)| k == flag)
    }

    fn get(&self, flag: &str) -> Option<String> {
        let mut found: Option<String> = None;
        for (k, v) in self.values.iter() {
            if k == flag {
                found = v.clone();
            }
        }
        found
    }

    fn get_u64(&self, flag: &str) -> Result<Option<u64>, String> {
        match self.get(flag) {
            Some(s) => match s.trim().parse::<u64>() {
                Ok(n) => Ok(Some(n)),
                Err(_) => Err(format!("{} expects a non-negative integer, got '{}'", flag, s)),
            },
            None => Ok(None),
        }
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("error: {}", msg);
    process::exit(2);
}

/// Agent config object from --depth / --time-budget-ms (expectimax only).
fn agent_config_from(args: &Args) -> Result<Option<Value>, String> {
    let mut m = Map::new();
    if let Some(d) = args.get("--depth") {
        let t = d.trim().to_string();
        if t == "auto" {
            m.insert(String::from("depth"), Value::from("auto"));
        } else {
            match t.parse::<u64>() {
                Ok(n) => {
                    m.insert(String::from("depth"), Value::from(n));
                }
                Err(_) => return Err(format!("--depth expects 'auto' or an integer, got '{}'", d)),
            }
        }
    }
    if let Some(ms) = args.get_u64("--time-budget-ms")? {
        m.insert(String::from("timeBudgetMs"), Value::from(ms));
    }
    if m.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Object(m)))
    }
}

fn write_output(out: Option<String>, text: &str) {
    match out {
        Some(path) => {
            if let Err(e) = fs::write(&path, format!("{}\n", text)) {
                fail(&format!("cannot write {}: {}", path, e));
            }
            eprintln!("wrote {}", path);
        }
        None => println!("{}", text),
    }
}

fn cmd_validate(args: &Args) -> i32 {
    let dir: PathBuf = match args.get("--fixtures") {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(g2048::DEFAULT_FIXTURES_DIR),
    };
    let report = validate_all(&dir);
    if args.has("--json") {
        let v = json!({
            "language": "rust",
            "passed": report.passed,
            "failed": report.failed,
            "failures": &report.failures,
        });
        println!("{}", v);
    } else {
        for f in report.failures.iter() {
            println!("FAIL {}", f);
        }
        println!(
            "rust: {} passed, {} failed ({})",
            report.passed,
            report.failed,
            dir.display()
        );
    }
    if report.ok() {
        0
    } else {
        1
    }
}

fn cmd_bench(args: &Args) -> i32 {
    let path = match args.get("--suite") {
        Some(p) => p,
        None => fail("bench requires --suite PATH"),
    };
    let suite = match BenchmarkSuite::load(&PathBuf::from(&path)) {
        Ok(s) => s,
        Err(e) => fail(&e),
    };
    let quiet = args.has("--quiet");
    let total = suite.seed_count;
    eprintln!("running suite {} ({} games, agent {})", suite.id, total, suite.agent_id);
    let mut progress = |r: &GameResult, i: usize| {
        if !quiet && (total <= 50 || (i as u64 + 1) % 100 == 0 || i as u64 + 1 == total) {
            eprintln!(
                "  [{}/{}] seed {} score {} max {} moves {} ({:.1} ms)",
                i + 1,
                total,
                r.seed,
                r.score,
                r.max_tile,
                r.move_count,
                r.wall_ms
            );
        }
    };
    let result = match run_suite_with(&suite, &mut progress) {
        Ok(r) => r,
        Err(e) => fail(&e),
    };
    eprintln!(
        "{}: checksum {} games {} moves {} score avg {:.1} max {} | {:.1} ms, {:.0} moves/s, {:.0} nodes/s",
        result.suite_id,
        result.checksum,
        result.summary.games,
        result.summary.total_moves,
        result.summary.avg_score,
        result.summary.max_score,
        result.summary.wall_ms,
        result.summary.moves_per_sec,
        result.summary.nodes_per_sec
    );
    let text = match serde_json::to_string_pretty(&result) {
        Ok(t) => t,
        Err(e) => fail(&format!("cannot serialise result: {}", e)),
    };
    write_output(args.get("--out"), &text);
    0
}

fn cmd_play(args: &Args) -> i32 {
    let seed: u32 = match args.get_u64("--seed") {
        Ok(Some(s)) => (s & 0xFFFF_FFFF) as u32,
        Ok(None) => random_seed(),
        Err(e) => fail(&e),
    };
    let agent_id = args.get("--agent").unwrap_or_else(|| String::from("expectimax"));
    let config = match agent_config_from(args) {
        Ok(c) => c,
        Err(e) => fail(&e),
    };
    let max_moves = match args.get_u64("--max-moves") {
        Ok(v) => v.unwrap_or(0),
        Err(e) => fail(&e),
    };
    let mut agent = match create_agent(&agent_id, config.as_ref()) {
        Ok(a) => a,
        Err(e) => fail(&e),
    };
    let mut timing: Vec<f64> = Vec::new();
    let out = match play_game(&mut *agent, seed, max_moves, true, &mut timing) {
        Ok(o) => o,
        Err(e) => fail(&e),
    };
    let snap = out.game.snapshot();
    eprintln!(
        "seed {}: score {} max tile {} moves {} over {} hash {} ({:.1} ms, {} nodes)",
        seed,
        snap.score,
        snap.max_tile,
        snap.move_count,
        snap.over,
        snap.history_hash,
        out.wall_ms,
        out.nodes
    );
    let b = out.game.board;
    for r in 0..4usize {
        let mut line = String::from("  ");
        for c in 0..4usize {
            let e = b[r * 4 + c];
            let v: u64 = if e == 0 { 0 } else { 1u64 << (e as u32) };
            line.push_str(&format!("{:>7}", if v == 0 { String::from(".") } else { v.to_string() }));
        }
        eprintln!("{}", line);
    }
    let timing_us: Vec<u64> = timing.iter().map(|x| *x as u64).collect();
    let replay = json!({
        "specVersion": SPEC_VERSION,
        "seed": seed,
        "moves": out.game.moves(),
        "final": snap,
        "timing": timing_us,
        "agent": {
            "name": agent.id(),
            "version": agent.version(),
            "config": agent.config(),
        },
        "runtime": {
            "language": "rust",
            "runtime": "native",
            "version": g2048::runtime_version(),
            "platform": std::env::consts::OS,
        },
    });
    let text = match serde_json::to_string(&replay) {
        Ok(t) => t,
        Err(e) => fail(&format!("cannot serialise replay: {}", e)),
    };
    write_output(args.get("--out"), &text);
    0
}

fn cmd_serve(args: &Args) -> i32 {
    let addr = args.get("--addr").unwrap_or_else(|| String::from("0.0.0.0:8080"));
    let agent_id = args.get("--agent").unwrap_or_else(|| String::from("expectimax"));
    let config = match agent_config_from(args) {
        Ok(c) => c,
        Err(e) => fail(&e),
    };
    match serve(ServerConfig {
        addr,
        agent_id,
        agent_config: config,
    }) {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 {
        eprint!("{}", USAGE);
        process::exit(2);
    }
    let cmd = argv[1].as_str();
    if cmd == "help" || cmd == "--help" || cmd == "-h" {
        print!("{}", USAGE);
        return;
    }
    let args = match Args::parse(&argv[2..]) {
        Ok(a) => a,
        Err(e) => fail(&e),
    };
    if args.has("--help") {
        print!("{}", USAGE);
        return;
    }
    let code = match cmd {
        "validate" => cmd_validate(&args),
        "bench" => cmd_bench(&args),
        "play" => cmd_play(&args),
        "serve" => cmd_serve(&args),
        other => {
            eprintln!("unknown command '{}'\n", other);
            eprint!("{}", USAGE);
            2
        }
    };
    process::exit(code);
}
