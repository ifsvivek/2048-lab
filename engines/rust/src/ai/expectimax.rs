//! AI.md §3 — canonical expectimax search with an exact transposition table.
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use super::bitboard::{count_empty, distinct_ranks, move_tables, MoveTables};
use super::heuristic::{breakdown, evaluate, line_table, Breakdown, Weights, HEURISTIC_V1};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DepthSetting {
    Auto,
    Fixed(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExpectimaxConfig {
    pub depth: DepthSetting,
    pub min_depth: u32,
    pub max_depth: u32,
    /// skip 4-spawns at chance nodes with at least this many empty cells (0 = never)
    pub four_prune_empties: u32,
    /// > 0 enables iterative deepening under a wall-clock budget (non-deterministic)
    pub time_budget_ms: u64,
    /// log2 of transposition table slots
    pub tt_bits: u32,
    pub weights: Weights,
}

impl Default for ExpectimaxConfig {
    /// The canonical profile.
    fn default() -> ExpectimaxConfig {
        ExpectimaxConfig {
            depth: DepthSetting::Auto,
            min_depth: 2,
            max_depth: 4,
            four_prune_empties: 0,
            time_budget_ms: 0,
            tt_bits: 20,
            weights: HEURISTIC_V1,
        }
    }
}

fn json_u64(v: &Value, key: &str) -> Result<u64, String> {
    if let Some(x) = v.as_u64() {
        return Ok(x);
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f >= 0.0 && f.fract() == 0.0 {
            return Ok(f as u64);
        }
    }
    Err(format!("config.{} must be a non-negative integer (got {})", key, v))
}

impl ExpectimaxConfig {
    /// Canonical profile overlaid with the keys present in `v` (a JSON object;
    /// `null` means "canonical").
    pub fn from_json(v: &Value) -> Result<ExpectimaxConfig, String> {
        let mut c = ExpectimaxConfig::default();
        if v.is_null() {
            return Ok(c);
        }
        let obj = match v.as_object() {
            Some(o) => o,
            None => return Err(String::from("expectimax config must be an object")),
        };
        for (k, val) in obj.iter() {
            match k.as_str() {
                "depth" => {
                    if val.as_str() == Some("auto") {
                        c.depth = DepthSetting::Auto;
                    } else {
                        let d = json_u64(val, "depth")?;
                        if d < 1 || d > 32 {
                            return Err(format!("config.depth must be 1..32 or \"auto\" (got {})", d));
                        }
                        c.depth = DepthSetting::Fixed(d as u32);
                    }
                }
                "minDepth" => c.min_depth = json_u64(val, "minDepth")?.min(32) as u32,
                "maxDepth" => c.max_depth = json_u64(val, "maxDepth")?.min(32) as u32,
                "fourPruneEmpties" => {
                    c.four_prune_empties = json_u64(val, "fourPruneEmpties")?.min(64) as u32
                }
                "timeBudgetMs" => c.time_budget_ms = json_u64(val, "timeBudgetMs")?,
                "ttBits" => {
                    let b = json_u64(val, "ttBits")?;
                    if b < 4 || b > 30 {
                        return Err(format!("config.ttBits must be 4..30 (got {})", b));
                    }
                    c.tt_bits = b as u32;
                }
                "weights" => c.weights = HEURISTIC_V1.merged_with(val)?,
                _ => {}
            }
        }
        if c.min_depth < 1 {
            c.min_depth = 1;
        }
        if c.max_depth < c.min_depth {
            c.max_depth = c.min_depth;
        }
        Ok(c)
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        let depth = match self.depth {
            DepthSetting::Auto => Value::from("auto"),
            DepthSetting::Fixed(d) => Value::from(d),
        };
        m.insert(String::from("depth"), depth);
        m.insert(String::from("minDepth"), Value::from(self.min_depth));
        m.insert(String::from("maxDepth"), Value::from(self.max_depth));
        m.insert(String::from("fourPruneEmpties"), Value::from(self.four_prune_empties));
        m.insert(String::from("timeBudgetMs"), Value::from(self.time_budget_ms));
        m.insert(String::from("ttBits"), Value::from(self.tt_bits));
        m.insert(String::from("weights"), self.weights.to_json());
        Value::Object(m)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SearchResult {
    /// best direction, `None` when no move is legal
    pub mv: Option<usize>,
    pub value: f64,
    /// root value per direction; `None` for invalid moves
    pub values: [Option<f64>; 4],
    pub depth: u32,
    pub nodes: u64,
    pub tt_hits: u64,
    pub tt_size: u64,
    pub time_us: u64,
    pub deterministic: bool,
    pub completed_depths: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Default)]
struct TtEntry {
    board: u64,
    /// 0 = empty slot (chance nodes always have depth >= 1)
    depth: u8,
    value: f64,
}

/// Exact-key transposition table: (board, depth) -> chance value.
struct TranspositionTable {
    entries: Vec<TtEntry>,
    mask: usize,
    size: usize,
}

const TT_PROBES: usize = 4;

impl TranspositionTable {
    fn new(bits: u32) -> TranspositionTable {
        let n: usize = 1usize << bits;
        TranspositionTable {
            entries: vec![TtEntry::default(); n],
            mask: n - 1,
            size: 0,
        }
    }

    /// Reference slot hash (spec/AI.md, TS `TranspositionTable.slot`) over the
    /// two 32-bit halves of the board and the depth, in u32 arithmetic.
    #[inline]
    fn slot(&self, board: u64, depth: u8) -> usize {
        let lo: u32 = (board & 0xFFFF_FFFF) as u32;
        let hi: u32 = (board >> 32) as u32;
        let d: u32 = depth as u32;
        let mut h: u32 = (lo ^ d.wrapping_mul(0x9E37_79B1)).wrapping_mul(0x85EB_CA6B)
            ^ hi.wrapping_mul(0xC2B2_AE35);
        h ^= h >> 15;
        h = h.wrapping_mul(0x2C1B_3C6D);
        h ^= h >> 12;
        (h as usize) & self.mask
    }

    #[inline]
    fn probe(&self, board: u64, depth: u8) -> Option<f64> {
        let mut s = self.slot(board, depth);
        for _ in 0..TT_PROBES {
            let e = &self.entries[s];
            if e.depth == 0 {
                return None;
            }
            if e.depth == depth && e.board == board {
                return Some(e.value);
            }
            s = (s + 1) & self.mask;
        }
        None
    }

    /// First empty slot in the probe window, else overwrite the home slot.
    #[inline]
    fn store(&mut self, board: u64, depth: u8, value: f64) {
        let home = self.slot(board, depth);
        let mut target = home;
        let mut s = home;
        for _ in 0..TT_PROBES {
            if self.entries[s].depth == 0 {
                target = s;
                self.size += 1;
                break;
            }
            s = (s + 1) & self.mask;
        }
        self.entries[target] = TtEntry { board, depth, value };
    }

    fn capacity(&self) -> usize {
        self.mask + 1
    }

    fn clear(&mut self) {
        for e in self.entries.iter_mut() {
            e.depth = 0;
        }
        self.size = 0;
    }
}

pub struct ExpectimaxSearch {
    pub config: ExpectimaxConfig,
    moves: &'static MoveTables,
    table: Vec<f64>,
    corner: i64,
    tt: TranspositionTable,
    nodes: u64,
    tt_hits: u64,
    ticks: u32,
    deadline: Option<Instant>,
    aborted: bool,
}

impl ExpectimaxSearch {
    pub fn new(config: ExpectimaxConfig) -> ExpectimaxSearch {
        let table = line_table(&config.weights);
        let corner = config.weights.corner;
        let tt = TranspositionTable::new(config.tt_bits);
        ExpectimaxSearch {
            config,
            moves: move_tables(),
            table,
            corner,
            tt,
            nodes: 0,
            tt_hits: 0,
            ticks: 0,
            deadline: None,
            aborted: false,
        }
    }

    pub fn canonical() -> ExpectimaxSearch {
        ExpectimaxSearch::new(ExpectimaxConfig::default())
    }

    #[inline]
    pub fn evaluate(&self, b: u64) -> f64 {
        evaluate(b, &self.table, self.corner)
    }

    pub fn breakdown(&self, b: u64) -> Breakdown {
        breakdown(b, &self.table, &self.config.weights)
    }

    pub fn depth_for(&self, b: u64) -> u32 {
        match self.config.depth {
            DepthSetting::Fixed(d) => d,
            DepthSetting::Auto => {
                let distinct = distinct_ranks(b) as i64;
                let wanted = distinct - 2;
                let lo = self.config.min_depth as i64;
                let hi = self.config.max_depth as i64;
                let clamped = if wanted > hi { hi } else { wanted };
                let clamped = if clamped < lo { lo } else { clamped };
                clamped as u32
            }
        }
    }

    fn maxnode(&mut self, b: u64, d: u32) -> f64 {
        self.nodes += 1;
        if d == 0 {
            return self.evaluate(b);
        }
        let mut best: f64 = 0.0;
        for dir in 0..4usize {
            let nb = self.moves.apply(b, dir);
            if nb == b {
                continue;
            }
            let v = self.chance(nb, d);
            if v > best {
                best = v;
            }
        }
        best
    }

    fn chance(&mut self, b: u64, d: u32) -> f64 {
        self.nodes += 1;
        self.ticks = self.ticks.wrapping_add(1);
        if (self.ticks & 0x3FF) == 0 {
            if let Some(dl) = self.deadline {
                if Instant::now() > dl {
                    self.aborted = true;
                }
            }
        }
        if self.aborted {
            return 0.0;
        }
        let key_depth = d as u8;
        if let Some(v) = self.tt.probe(b, key_depth) {
            self.tt_hits += 1;
            return v;
        }

        let n = count_empty(b);
        let prune = self.config.four_prune_empties;
        let four = !(prune > 0 && n >= prune);
        let mut sum: f64 = 0.0;
        for i in 0..16u32 {
            let shift = 4 * i;
            if ((b >> shift) & 0xF) != 0 {
                continue;
            }
            if four {
                let v2 = self.maxnode(b | (1u64 << shift), d - 1);
                sum = sum + 0.9 * v2;
                let v4 = self.maxnode(b | (2u64 << shift), d - 1);
                sum = sum + 0.1 * v4;
            } else {
                let v2 = self.maxnode(b | (1u64 << shift), d - 1);
                sum = sum + v2;
            }
        }
        let v = sum / (n as f64);
        if self.aborted {
            return 0.0;
        }
        self.tt.store(b, key_depth, v);
        v
    }

    fn root(&mut self, b: u64, depth: u32) -> (Option<usize>, f64, [Option<f64>; 4]) {
        let mut mv: Option<usize> = None;
        let mut value: f64 = f64::NEG_INFINITY;
        let mut values: [Option<f64>; 4] = [None, None, None, None];
        for dir in 0..4usize {
            let nb = self.moves.apply(b, dir);
            if nb == b {
                continue;
            }
            let v = self.chance(nb, depth);
            values[dir] = Some(v);
            if v > value {
                value = v;
                mv = Some(dir);
            }
        }
        (mv, value, values)
    }

    /// Search the bitboard `b` and return the decision with metrics.
    pub fn search(&mut self, b: u64) -> SearchResult {
        let start = Instant::now();
        self.nodes = 0;
        self.tt_hits = 0;
        self.aborted = false;
        self.deadline = None;
        if (self.tt.size as f64) > (self.tt.capacity() as f64) * 0.75 {
            self.tt.clear();
        }

        let budget = self.config.time_budget_ms;
        if budget == 0 {
            let depth = self.depth_for(b);
            let (mv, value, values) = self.root(b, depth);
            return self.result(mv, value, values, depth, start, true, vec![depth]);
        }

        // Iterative deepening: keep the deepest completed iteration.
        let (mut mv, mut value, mut values) = self.root(b, 1);
        let mut depth: u32 = 1;
        let mut completed: Vec<u32> = vec![1];
        self.deadline = Some(start + Duration::from_millis(budget));
        let mut d: u32 = 2;
        while d <= self.config.max_depth {
            let r = self.root(b, d);
            if self.aborted {
                break;
            }
            mv = r.0;
            value = r.1;
            values = r.2;
            depth = d;
            completed.push(d);
            d += 1;
        }
        self.deadline = None;
        self.aborted = false;
        self.result(mv, value, values, depth, start, false, completed)
    }

    #[allow(clippy::too_many_arguments)]
    fn result(
        &self,
        mv: Option<usize>,
        value: f64,
        values: [Option<f64>; 4],
        depth: u32,
        start: Instant,
        deterministic: bool,
        completed_depths: Vec<u32>,
    ) -> SearchResult {
        let elapsed = start.elapsed();
        SearchResult {
            mv,
            value,
            values,
            depth,
            nodes: self.nodes,
            tt_hits: self.tt_hits,
            tt_size: self.tt.size as u64,
            time_us: ((elapsed.as_nanos() + 500) / 1000) as u64,
            deterministic,
            completed_depths,
        }
    }
}
