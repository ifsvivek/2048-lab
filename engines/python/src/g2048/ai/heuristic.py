"""AI.md §2 — line-decomposable heuristic with integer weights.

Table values are Python ints; with integer weights every value is an exact
integer below 2**53, so they convert to float64 losslessly and match the
float64 tables of the other ports bit for bit.
"""

from __future__ import annotations

from .bitboard import MASK16, RANK_MASK, column

WEIGHT_KEYS = ("lost", "empty", "merges", "mono", "sum", "smooth", "stable", "corner")
FEATURE_KEYS = ("empty", "merges", "mono", "sum", "smooth", "stable")

HEURISTIC_V1 = {
    "lost": 200000,
    "empty": 270,
    "merges": 700,
    "mono": 47,
    "sum": 11,
    "smooth": 0,
    "stable": 0,
    "corner": 0,
}


def normalize_weights(weights: dict | None = None) -> dict:
    """Merge ``weights`` over HEURISTIC_V1 and validate that every weight is an integer."""
    w = dict(HEURISTIC_V1)
    if weights:
        for k, v in weights.items():
            if k not in HEURISTIC_V1:
                raise ValueError(f"unknown heuristic weight {k!r}")
            w[k] = v
    for k, v in w.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"heuristic weight {k!r} must be an integer (got {v!r})")
        if isinstance(v, float):
            if not v.is_integer():
                raise ValueError(f"heuristic weight {k!r} must be an integer (got {v!r})")
            w[k] = int(v)
    return w


def line_features(v: int) -> dict:
    r = (v & 0xF, (v >> 4) & 0xF, (v >> 8) & 0xF, (v >> 12) & 0xF)
    empty = 0
    merges = 0
    prev = 0
    counter = 0
    total = 0
    for rank in r:
        total += rank * rank * rank
        if rank == 0:
            empty += 1
            continue
        if prev == rank:
            counter += 1
        elif counter > 0:
            merges += 1 + counter
            counter = 0
        prev = rank
    if counter > 0:
        merges += 1 + counter

    mono_l = 0
    mono_r = 0
    smooth = 0
    for i in range(1, 4):
        a = r[i - 1] ** 4
        b = r[i] ** 4
        if r[i - 1] > r[i]:
            mono_l += a - b
        else:
            mono_r += b - a
        if r[i - 1] != 0 and r[i] != 0:
            smooth += abs(r[i - 1] - r[i])
    stable = 1 if empty == 0 and (mono_l == 0 or mono_r == 0) else 0
    return {"empty": empty, "merges": merges, "mono": min(mono_l, mono_r), "sum": total, "smooth": smooth, "stable": stable}


def line_score(f: dict, w: dict) -> int:
    return (
        w["lost"]
        + w["empty"] * f["empty"]
        + w["merges"] * f["merges"]
        - w["mono"] * f["mono"]
        - w["sum"] * f["sum"]
        - w["smooth"] * f["smooth"]
        + w["stable"] * f["stable"]
    )


_FEATURES: list | None = None
_TABLES: dict = {}


def _all_features() -> list:
    global _FEATURES
    if _FEATURES is None:
        _FEATURES = [line_features(v) for v in range(65536)]
    return _FEATURES


def line_table(weights: dict | None = None) -> list[int]:
    """65536-entry per-line score table for the given weights (memoised)."""
    w = normalize_weights(weights)
    key = tuple(w[k] for k in WEIGHT_KEYS[:7])
    t = _TABLES.get(key)
    if t is None:
        lost, e, m, mo, s, sm, st = key
        t = [
            lost + e * f["empty"] + m * f["merges"] - mo * f["mono"] - s * f["sum"] - sm * f["smooth"] + st * f["stable"]
            for f in _all_features()
        ]
        _TABLES[key] = t
    return t


def corner_term(b: int, corner_weight: int) -> int:
    if corner_weight == 0:
        return 0
    m = RANK_MASK
    mx = (m[b & MASK16] | m[(b >> 16) & MASK16] | m[(b >> 32) & MASK16] | m[b >> 48]).bit_length() - 1
    if (b & 0xF) == mx or ((b >> 12) & 0xF) == mx or ((b >> 48) & 0xF) == mx or (b >> 60) == mx:
        return corner_weight * mx
    return 0


def lines_of(b: int) -> list[int]:
    return [
        b & MASK16,
        (b >> 16) & MASK16,
        (b >> 32) & MASK16,
        b >> 48,
        column(b, 0),
        column(b, 1),
        column(b, 2),
        column(b, 3),
    ]


def evaluate(b: int, table: list, corner_weight: int = 0) -> int:
    t = 0
    for v in lines_of(b):
        t += table[v]
    return t + corner_term(b, corner_weight)


def breakdown(b: int, weights: dict | None = None, table: list | None = None) -> dict:
    """Heuristic features summed over all 8 lines, plus the corner term and the total.

    ``weights`` must already be normalised when ``table`` (its line table) is passed.
    """
    w = weights if table is not None else normalize_weights(weights)
    if table is None:
        table = line_table(w)
    feats = _all_features()
    empty = merges = mono = total = smooth = stable = 0
    ev = 0
    for v in lines_of(b):
        f = feats[v]
        empty += f["empty"]
        merges += f["merges"]
        mono += f["mono"]
        total += f["sum"]
        smooth += f["smooth"]
        stable += f["stable"]
        ev += table[v]
    corner = corner_term(b, w["corner"])
    return {
        "empty": empty,
        "merges": merges,
        "mono": mono,
        "sum": total,
        "smooth": smooth,
        "stable": stable,
        "corner": corner,
        "total": ev + corner,
    }
