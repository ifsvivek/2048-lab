//! AI.md §2 — line-decomposable heuristic with integer weights.
use serde::Serialize;
use serde_json::{Map, Value};

use super::bitboard::{column, max_rank, nibble};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Weights {
    pub lost: i64,
    pub empty: i64,
    pub merges: i64,
    pub mono: i64,
    pub sum: i64,
    pub smooth: i64,
    pub stable: i64,
    pub corner: i64,
}

pub const HEURISTIC_V1: Weights = Weights {
    lost: 200000,
    empty: 270,
    merges: 700,
    mono: 47,
    sum: 11,
    smooth: 0,
    stable: 0,
    corner: 0,
};

impl Default for Weights {
    fn default() -> Weights {
        HEURISTIC_V1
    }
}

fn integer_weight(v: &Value, key: &str) -> Result<i64, String> {
    if let Some(i) = v.as_i64() {
        return Ok(i);
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 {
            return Ok(f as i64);
        }
    }
    Err(format!("heuristic weight '{}' must be an integer (got {})", key, v))
}

impl Weights {
    /// Overlay a (possibly partial) JSON weights object on top of `self`.
    pub fn merged_with(&self, v: &Value) -> Result<Weights, String> {
        let obj = match v.as_object() {
            Some(o) => o,
            None => return Err(String::from("weights must be an object")),
        };
        let mut w = *self;
        for (k, val) in obj.iter() {
            let x = integer_weight(val, k)?;
            match k.as_str() {
                "lost" => w.lost = x,
                "empty" => w.empty = x,
                "merges" => w.merges = x,
                "mono" => w.mono = x,
                "sum" => w.sum = x,
                "smooth" => w.smooth = x,
                "stable" => w.stable = x,
                "corner" => w.corner = x,
                _ => return Err(format!("unknown heuristic weight '{}'", k)),
            }
        }
        Ok(w)
    }

    pub fn from_json(v: &Value) -> Result<Weights, String> {
        HEURISTIC_V1.merged_with(v)
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert(String::from("lost"), Value::from(self.lost));
        m.insert(String::from("empty"), Value::from(self.empty));
        m.insert(String::from("merges"), Value::from(self.merges));
        m.insert(String::from("mono"), Value::from(self.mono));
        m.insert(String::from("sum"), Value::from(self.sum));
        m.insert(String::from("smooth"), Value::from(self.smooth));
        m.insert(String::from("stable"), Value::from(self.stable));
        m.insert(String::from("corner"), Value::from(self.corner));
        Value::Object(m)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LineFeatures {
    pub empty: i64,
    pub merges: i64,
    pub mono: i64,
    pub sum: i64,
    pub smooth: i64,
    pub stable: i64,
}

pub fn line_features(v: u16) -> LineFeatures {
    let r: [i64; 4] = [
        (v & 0xF) as i64,
        ((v >> 4) & 0xF) as i64,
        ((v >> 8) & 0xF) as i64,
        ((v >> 12) & 0xF) as i64,
    ];
    let mut empty: i64 = 0;
    let mut merges: i64 = 0;
    let mut prev: i64 = 0;
    let mut counter: i64 = 0;
    let mut sum: i64 = 0;
    for k in 0..4usize {
        let rank = r[k];
        sum += rank * rank * rank;
        if rank == 0 {
            empty += 1;
            continue;
        }
        if prev == rank {
            counter += 1;
        } else if counter > 0 {
            merges += 1 + counter;
            counter = 0;
        }
        prev = rank;
    }
    if counter > 0 {
        merges += 1 + counter;
    }

    let mut mono_l: i64 = 0;
    let mut mono_r: i64 = 0;
    let mut smooth: i64 = 0;
    for i in 1..4usize {
        let a = r[i - 1] * r[i - 1] * r[i - 1] * r[i - 1];
        let b = r[i] * r[i] * r[i] * r[i];
        if r[i - 1] > r[i] {
            mono_l += a - b;
        } else {
            mono_r += b - a;
        }
        if r[i - 1] != 0 && r[i] != 0 {
            smooth += (r[i - 1] - r[i]).abs();
        }
    }
    let stable: i64 = if empty == 0 && (mono_l == 0 || mono_r == 0) { 1 } else { 0 };
    LineFeatures {
        empty,
        merges,
        mono: if mono_l < mono_r { mono_l } else { mono_r },
        sum,
        smooth,
        stable,
    }
}

/// Exact integer line score (all intermediates are far below 2^53).
pub fn line_score(f: &LineFeatures, w: &Weights) -> f64 {
    let s: i64 = w.lost + w.empty * f.empty + w.merges * f.merges
        - w.mono * f.mono
        - w.sum * f.sum
        - w.smooth * f.smooth
        + w.stable * f.stable;
    s as f64
}

/// 65536-entry per-line score table for the given weights.
pub fn line_table(w: &Weights) -> Vec<f64> {
    let mut t: Vec<f64> = vec![0.0f64; 65536];
    for v in 0..65536usize {
        t[v] = line_score(&line_features(v as u16), w);
    }
    t
}

pub fn corner_term(b: u64, corner_weight: i64) -> f64 {
    if corner_weight == 0 {
        return 0.0;
    }
    let max = max_rank(b) as u8;
    let c0 = nibble(b, 0);
    let c3 = nibble(b, 3);
    let c12 = nibble(b, 12);
    let c15 = nibble(b, 15);
    if c0 == max || c3 == max || c12 == max || c15 == max {
        (corner_weight * (max as i64)) as f64
    } else {
        0.0
    }
}

/// Σ line(row) + Σ line(col) + corner.
#[inline]
pub fn evaluate(b: u64, table: &[f64], corner_weight: i64) -> f64 {
    let rows = table[(b & 0xFFFF) as usize]
        + table[((b >> 16) & 0xFFFF) as usize]
        + table[((b >> 32) & 0xFFFF) as usize]
        + table[((b >> 48) & 0xFFFF) as usize];
    let cols = table[column(b, 0) as usize]
        + table[column(b, 1) as usize]
        + table[column(b, 2) as usize]
        + table[column(b, 3) as usize];
    let corner = if corner_weight == 0 { 0.0 } else { corner_term(b, corner_weight) };
    rows + cols + corner
}

/// Human-readable decomposition of the evaluation, summed over all 8 lines.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Breakdown {
    pub empty: i64,
    pub merges: i64,
    pub mono: i64,
    pub sum: i64,
    pub smooth: i64,
    pub stable: i64,
    pub corner: f64,
    pub total: f64,
}

pub fn breakdown(b: u64, table: &[f64], w: &Weights) -> Breakdown {
    let lines: [u16; 8] = [
        (b & 0xFFFF) as u16,
        ((b >> 16) & 0xFFFF) as u16,
        ((b >> 32) & 0xFFFF) as u16,
        ((b >> 48) & 0xFFFF) as u16,
        column(b, 0),
        column(b, 1),
        column(b, 2),
        column(b, 3),
    ];
    let mut acc = Breakdown::default();
    for &v in lines.iter() {
        let f = line_features(v);
        acc.empty += f.empty;
        acc.merges += f.merges;
        acc.mono += f.mono;
        acc.sum += f.sum;
        acc.smooth += f.smooth;
        acc.stable += f.stable;
    }
    acc.corner = corner_term(b, w.corner);
    acc.total = evaluate(b, table, w.corner);
    acc
}
