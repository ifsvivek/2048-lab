//! Game simulation and the benchmark-suite runner. Suite/result shapes follow
//! spec/benchmarks/*.json and spec/schemas/benchmark-result.schema.json.
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::ai::agents::{create_agent, Agent};
use crate::board::max_exponent;
use crate::game::{Game, SPEC_VERSION};
use crate::hash::{fnv1a32, hash_hex};

pub const REACH_TILES: [u64; 6] = [2048, 4096, 8192, 16384, 32768, 65536];

#[derive(Clone, Debug, PartialEq)]
pub struct BenchmarkSuite {
    pub id: String,
    pub name: String,
    pub spec_version: u64,
    pub agent_id: String,
    pub agent_config: Option<Value>,
    pub seed_start: u64,
    pub seed_count: u64,
    /// stop a game after this many moves (0 = play to completion)
    pub max_moves: u64,
    /// record per-decision latency
    pub time_decisions: bool,
}

impl BenchmarkSuite {
    pub fn from_json(v: &Value) -> Result<BenchmarkSuite, String> {
        let id = v
            .get("id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| String::from("suite.id missing"))?
            .to_string();
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or(id.as_str()).to_string();
        let spec_version = v
            .get("specVersion")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| String::from("suite.specVersion missing"))?;
        let agent = v.get("agent").ok_or_else(|| String::from("suite.agent missing"))?;
        let agent_id = agent
            .get("id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| String::from("suite.agent.id missing"))?
            .to_string();
        let agent_config = agent.get("config").cloned();
        let seeds = v.get("seeds").ok_or_else(|| String::from("suite.seeds missing"))?;
        let seed_start = seeds
            .get("start")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| String::from("suite.seeds.start missing"))?;
        let seed_count = seeds
            .get("count")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| String::from("suite.seeds.count missing"))?;
        let max_moves = v.get("maxMoves").and_then(|x| x.as_u64()).unwrap_or(0);
        let time_decisions = v.get("timeDecisions").and_then(|x| x.as_bool()).unwrap_or(false);
        Ok(BenchmarkSuite {
            id,
            name,
            spec_version,
            agent_id,
            agent_config,
            seed_start,
            seed_count,
            max_moves,
            time_decisions,
        })
    }

    pub fn load(path: &Path) -> Result<BenchmarkSuite, String> {
        let text = fs::read_to_string(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {}", path.display(), e))?;
        BenchmarkSuite::from_json(&v)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameResult {
    pub seed: u32,
    pub score: u64,
    pub max_tile: u64,
    pub move_count: u64,
    pub over: bool,
    pub history_hash: String,
    pub wall_ms: f64,
    pub nodes: u64,
}

/// Map with caller-defined key order (numeric order for tile keys).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OrderedMap<V> {
    pub entries: Vec<(String, V)>,
}

impl<V: Serialize> Serialize for OrderedMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (k, v) in self.entries.iter() {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkSummary {
    pub games: u64,
    pub avg_score: f64,
    pub median_score: u64,
    pub min_score: u64,
    pub max_score: u64,
    pub max_tile: u64,
    pub total_moves: u64,
    pub wall_ms: f64,
    pub cpu_ms: Option<f64>,
    pub games_per_sec: f64,
    pub moves_per_sec: f64,
    pub decisions_per_sec: f64,
    pub nodes: u64,
    pub nodes_per_sec: f64,
    pub peak_memory_bytes: Option<u64>,
    pub avg_decision_us: Option<f64>,
    #[serde(rename = "p50DecisionUs")]
    pub p50_decision_us: Option<f64>,
    #[serde(rename = "p99DecisionUs")]
    pub p99_decision_us: Option<f64>,
    /// count of games whose max tile is exactly this value
    pub tile_distribution: OrderedMap<u64>,
    /// fraction of games reaching at least this tile
    pub reach_rates: OrderedMap<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Implementation {
    pub language: String,
    pub runtime: String,
    pub runtime_version: String,
    pub engine_version: String,
    pub platform: String,
}

impl Implementation {
    pub fn current() -> Implementation {
        Implementation {
            language: String::from("rust"),
            runtime: String::from("native"),
            runtime_version: crate::runtime_version().to_string(),
            engine_version: crate::ENGINE_VERSION.to_string(),
            platform: std::env::consts::OS.to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AgentRef {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub schema_version: u32,
    pub suite_id: String,
    pub spec_version: u64,
    pub implementation: Implementation,
    pub environment: Map<String, Value>,
    pub agent: AgentRef,
    pub deterministic: bool,
    pub started_at: String,
    pub finished_at: String,
    pub games: Vec<GameResult>,
    pub summary: BenchmarkSummary,
    /// fnv1a32 over the concatenated historyHash strings
    pub checksum: String,
}

impl BenchmarkResult {
    pub fn total_score(&self) -> u64 {
        self.games.iter().map(|g| g.score).sum()
    }
}

/// Outcome of playing one game with an agent.
pub struct PlayOutcome {
    pub game: Game,
    pub nodes: u64,
    pub wall_ms: f64,
}

/// Play `agent` from `new_game(seed)` until the game is over or `max_moves`
/// moves were made (0 = no limit). Decision times (µs) are appended to
/// `decisions` when `record` is set.
pub fn play_game(
    agent: &mut dyn Agent,
    seed: u32,
    max_moves: u64,
    record: bool,
    decisions: &mut Vec<f64>,
) -> Result<PlayOutcome, String> {
    let t0 = Instant::now();
    let mut game = Game::new(seed);
    agent.reset(seed);
    let mut nodes: u64 = 0;
    while (max_moves == 0 || game.move_count < max_moves) && !game.over() {
        let d = agent.decide(&game.board);
        if game.apply(d.mv).is_none() {
            return Err(format!(
                "agent {} returned invalid move {} at {}",
                agent.id(),
                d.mv,
                game.move_count
            ));
        }
        nodes += d.metrics.nodes.unwrap_or(0);
        if record {
            decisions.push(d.metrics.time_us as f64);
        }
    }
    let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
    Ok(PlayOutcome { game, nodes, wall_ms })
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let n = sorted.len();
    let idx = (p * (n as f64)).floor() as usize;
    sorted[if idx < n - 1 { idx } else { n - 1 }]
}

pub fn summarise(
    games: &[GameResult],
    wall_ms: f64,
    cpu_ms: Option<f64>,
    peak_memory_bytes: Option<u64>,
    decisions: Option<&[f64]>,
) -> BenchmarkSummary {
    let n = games.len();
    let mut scores: Vec<u64> = games.iter().map(|g| g.score).collect();
    scores.sort_unstable();
    let total_moves: u64 = games.iter().map(|g| g.move_count).sum();
    let nodes: u64 = games.iter().map(|g| g.nodes).sum();
    let total_score: u64 = scores.iter().sum();

    let mut dist: BTreeMap<u64, u64> = BTreeMap::new();
    for g in games.iter() {
        *dist.entry(g.max_tile).or_insert(0) += 1;
    }
    let mut tile_distribution = OrderedMap { entries: Vec::new() };
    for (k, v) in dist.iter() {
        tile_distribution.entries.push((k.to_string(), *v));
    }
    let mut reach_rates = OrderedMap { entries: Vec::new() };
    for &t in REACH_TILES.iter() {
        let rate = if n > 0 {
            (games.iter().filter(|g| g.max_tile >= t).count() as f64) / (n as f64)
        } else {
            0.0
        };
        reach_rates.entries.push((t.to_string(), rate));
    }

    let secs = wall_ms / 1000.0;
    let mut avg_decision_us: Option<f64> = None;
    let mut p50: Option<f64> = None;
    let mut p99: Option<f64> = None;
    if let Some(ds) = decisions {
        if !ds.is_empty() {
            let mut sorted: Vec<f64> = ds.to_vec();
            sorted.sort_by(|a, b| a.total_cmp(b));
            let mut s = 0.0f64;
            for x in sorted.iter() {
                s += *x;
            }
            avg_decision_us = Some(s / (sorted.len() as f64));
            p50 = Some(percentile(&sorted, 0.5));
            p99 = Some(percentile(&sorted, 0.99));
        }
    }
    let per_sec = |count: f64| -> f64 {
        if secs > 0.0 {
            count / secs
        } else {
            0.0
        }
    };
    BenchmarkSummary {
        games: n as u64,
        avg_score: if n > 0 { (total_score as f64) / (n as f64) } else { 0.0 },
        median_score: if n > 0 { scores[n / 2] } else { 0 },
        min_score: if n > 0 { scores[0] } else { 0 },
        max_score: if n > 0 { scores[n - 1] } else { 0 },
        max_tile: games.iter().map(|g| g.max_tile).max().unwrap_or(0),
        total_moves,
        wall_ms,
        cpu_ms,
        games_per_sec: per_sec(n as f64),
        moves_per_sec: per_sec(total_moves as f64),
        decisions_per_sec: per_sec(total_moves as f64),
        nodes,
        nodes_per_sec: per_sec(nodes as f64),
        peak_memory_bytes,
        avg_decision_us,
        p50_decision_us: p50,
        p99_decision_us: p99,
        tile_distribution,
        reach_rates,
    }
}

/// fnv1a32 over the ASCII bytes of the concatenated historyHash strings.
pub fn suite_checksum(games: &[GameResult]) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(games.len() * 8);
    for g in games.iter() {
        bytes.extend_from_slice(g.history_hash.as_bytes());
    }
    hash_hex(fnv1a32(&bytes))
}

/// Run a suite. `on_game` is called after every game (progress reporting).
pub fn run_suite_with(
    suite: &BenchmarkSuite,
    on_game: &mut dyn FnMut(&GameResult, usize),
) -> Result<BenchmarkResult, String> {
    if suite.spec_version != SPEC_VERSION {
        return Err(format!("suite {} targets spec v{}", suite.id, suite.spec_version));
    }
    let mut agent = create_agent(&suite.agent_id, suite.agent_config.as_ref())?;
    let started_at = iso_now();
    let cpu0 = process_cpu_ms();
    let t0 = Instant::now();
    let mut decisions: Vec<f64> = Vec::new();
    let mut games: Vec<GameResult> = Vec::with_capacity(suite.seed_count as usize);
    for i in 0..suite.seed_count {
        let seed = (suite.seed_start.wrapping_add(i) & 0xFFFF_FFFF) as u32;
        let out = play_game(&mut *agent, seed, suite.max_moves, suite.time_decisions, &mut decisions)?;
        let r = GameResult {
            seed,
            score: out.game.score,
            max_tile: 1u64 << (max_exponent(&out.game.board) as u32),
            move_count: out.game.move_count,
            over: out.game.over(),
            history_hash: out.game.history_hash(),
            wall_ms: out.wall_ms,
            nodes: out.nodes,
        };
        on_game(&r, i as usize);
        games.push(r);
    }
    let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let cpu1 = process_cpu_ms();
    let cpu_ms = match (cpu0, cpu1) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    let deterministic = match &suite.agent_config {
        Some(cfg) => !cfg.get("timeBudgetMs").and_then(|x| x.as_f64()).map(|x| x > 0.0).unwrap_or(false),
        None => true,
    };
    let summary = summarise(
        &games,
        wall_ms,
        cpu_ms,
        peak_memory_bytes(),
        if suite.time_decisions { Some(&decisions[..]) } else { None },
    );
    let checksum = suite_checksum(&games);
    Ok(BenchmarkResult {
        schema_version: 1,
        suite_id: suite.id.clone(),
        spec_version: SPEC_VERSION,
        implementation: Implementation::current(),
        environment: environment(),
        agent: AgentRef {
            id: suite.agent_id.clone(),
            config: suite.agent_config.clone(),
        },
        deterministic,
        started_at,
        finished_at: iso_now(),
        games,
        summary,
        checksum,
    })
}

pub fn run_suite(suite: &BenchmarkSuite) -> Result<BenchmarkResult, String> {
    let mut noop = |_r: &GameResult, _i: usize| {};
    run_suite_with(suite, &mut noop)
}

// ------------------------------------------------------------ host facts

fn read_file(path: &str) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// Peak resident set size (VmHWM) in bytes, if measurable.
pub fn peak_memory_bytes() -> Option<u64> {
    let status = read_file("/proc/self/status")?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

/// Cumulative process CPU time (user + system) in ms, if measurable.
pub fn process_cpu_ms() -> Option<f64> {
    let stat = read_file("/proc/self/stat")?;
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // fields[0] is field 3 (state); utime is field 14, stime field 15.
    if fields.len() < 13 {
        return None;
    }
    let utime: f64 = fields[11].parse().ok()?;
    let stime: f64 = fields[12].parse().ok()?;
    Some((utime + stime) * 10.0)
}

fn cpu_model() -> Option<String> {
    let info = read_file("/proc/cpuinfo")?;
    for line in info.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("model name") || lower.starts_with("hardware") {
            if let Some(pos) = line.find(':') {
                let v = line[pos + 1..].trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

fn total_memory_bytes() -> Option<u64> {
    let info = read_file("/proc/meminfo")?;
    for line in info.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

/// Free-form host facts for benchmark results.
pub fn environment() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(String::from("os"), Value::from(std::env::consts::OS));
    m.insert(String::from("arch"), Value::from(std::env::consts::ARCH));
    let cpus: u64 = match std::thread::available_parallelism() {
        Ok(n) => n.get() as u64,
        Err(_) => 1,
    };
    m.insert(String::from("cpus"), Value::from(cpus));
    if let Some(model) = cpu_model() {
        m.insert(String::from("cpu"), Value::from(model));
    }
    if let Some(mem) = total_memory_bytes() {
        m.insert(String::from("memoryBytes"), Value::from(mem));
    }
    // The expectimax TT follows the reference policy of spec/AI.md §3.
    m.insert(String::from("ttPolicy"), Value::from("reference"));
    m
}

// ------------------------------------------------------------ timestamps

/// (year, month, day) for days since 1970-01-01 (proleptic Gregorian).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z: i64 = days + 719_468;
    let era: i64 = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe: i64 = z - era * 146_097;
    let yoe: i64 = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y: i64 = yoe + era * 400;
    let doy: i64 = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp: i64 = (5 * doy + 2) / 153;
    let d: i64 = doy - (153 * mp + 2) / 5 + 1;
    let m: i64 = if mp < 10 { mp + 3 } else { mp - 9 };
    let year: i64 = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32)
}

/// ISO-8601 UTC timestamp with millisecond precision for `ms` since the epoch.
pub fn iso_from_millis(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let h = rem / 3_600_000;
    let mi = (rem / 60_000) % 60;
    let s = (rem / 1000) % 60;
    let frac = rem % 1000;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, mo, d, h, mi, s, frac)
}

pub fn iso_now() -> String {
    let ms: i64 = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    };
    iso_from_millis(ms)
}
