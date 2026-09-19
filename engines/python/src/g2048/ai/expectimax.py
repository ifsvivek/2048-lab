"""AI.md §3 — canonical expectimax search with an exact transposition table.

The recursion is implemented as two closures (``chance1`` for ``chance(b, 1)``,
whose children are leaves, and ``chance_n`` for deeper chance nodes). The
maxnode layer is inlined into its parent chance node, and child boards are
derived incrementally: a spawn at ``(r, c)`` only changes row ``r`` and column
``c``, so the four move results and the leaf evaluations of every child are
patched from the parent's per-line values instead of recomputed.

Every floating-point operation happens in exactly the order AI.md prescribes:
leaf evaluations are exact integers, and each chance node accumulates
``s = s + 0.9 * v2; s = s + 0.1 * v4`` per empty cell in ascending cell order,
then returns ``s / n``. Results are therefore bit-identical to the other ports.
"""

from __future__ import annotations

import time

from .bitboard import COL_DOWN, COL_UP, EMPTY_COUNT, EMPTY_POS, MASK16, RANK_MASK, ROW_LEFT, ROW_RIGHT, TRANSPOSE, moves4
from .heuristic import breakdown, corner_term, evaluate, line_table, normalize_weights

_INF_NODES = 1 << 62
_MAX_TT_DEPTH = 64


class ExpectimaxConfig:
    __slots__ = ("depth", "min_depth", "max_depth", "four_prune_empties", "time_budget_ms", "tt_bits", "weights")

    def __init__(
        self,
        depth="auto",
        min_depth: int = 2,
        max_depth: int = 4,
        four_prune_empties: int = 0,
        time_budget_ms: float = 0,
        tt_bits: int = 20,
        weights: dict | None = None,
    ) -> None:
        if depth != "auto":
            depth = int(depth)
            if depth < 1:
                raise ValueError("depth must be >= 1 or 'auto'")
        self.depth = depth
        self.min_depth = int(min_depth)
        self.max_depth = int(max_depth)
        if self.min_depth < 1 or self.max_depth < self.min_depth:
            raise ValueError("require 1 <= minDepth <= maxDepth")
        if self.max_depth >= _MAX_TT_DEPTH or (depth != "auto" and depth >= _MAX_TT_DEPTH):
            raise ValueError(f"depth must be < {_MAX_TT_DEPTH}")
        self.four_prune_empties = int(four_prune_empties)
        self.time_budget_ms = time_budget_ms
        self.tt_bits = int(tt_bits)
        self.weights = normalize_weights(weights)

    _KEYS = {
        "depth": "depth",
        "minDepth": "min_depth",
        "min_depth": "min_depth",
        "maxDepth": "max_depth",
        "max_depth": "max_depth",
        "fourPruneEmpties": "four_prune_empties",
        "four_prune_empties": "four_prune_empties",
        "timeBudgetMs": "time_budget_ms",
        "time_budget_ms": "time_budget_ms",
        "ttBits": "tt_bits",
        "tt_bits": "tt_bits",
        "weights": "weights",
    }

    @classmethod
    def from_dict(cls, d: dict | None) -> "ExpectimaxConfig":
        if d is None:
            return cls()
        if isinstance(d, ExpectimaxConfig):
            return d
        kw = {}
        for k, v in d.items():
            if k not in cls._KEYS:
                raise ValueError(f"unknown expectimax config key {k!r}")
            if v is None:
                continue
            kw[cls._KEYS[k]] = v
        return cls(**kw)

    def to_dict(self) -> dict:
        return {
            "depth": self.depth,
            "minDepth": self.min_depth,
            "maxDepth": self.max_depth,
            "fourPruneEmpties": self.four_prune_empties,
            "timeBudgetMs": self.time_budget_ms,
            "ttBits": self.tt_bits,
            "weights": dict(self.weights),
        }


CANONICAL_EXPECTIMAX = ExpectimaxConfig().to_dict()


class SearchResult:
    __slots__ = ("move", "value", "values", "depth", "nodes", "tt_hits", "tt_size", "time_us", "deterministic", "completed_depths")

    def __init__(self, move, value, values, depth, nodes, tt_hits, tt_size, time_us, deterministic, completed_depths):
        self.move = move
        self.value = value
        self.values = values
        self.depth = depth
        self.nodes = nodes
        self.tt_hits = tt_hits
        self.tt_size = tt_size
        self.time_us = time_us
        self.deterministic = deterministic
        self.completed_depths = completed_depths

    def __repr__(self) -> str:
        return f"SearchResult(move={self.move}, depth={self.depth}, values={self.values}, nodes={self.nodes})"


class _Timeout(Exception):
    pass


def _build_core(H, corner_w, prune, tts, clock):
    """Create the search closures. Returns a namespace of functions sharing the counters."""
    T0, T1, T2, T3 = TRANSPOSE
    U0, U1, U2, U3 = COL_UP
    D0, D1, D2, D3 = COL_DOWN
    L0, L1, L2, L3 = ROW_LEFT
    R0, R1, R2, R3 = ROW_RIGHT
    LT = ROW_LEFT
    RT = ROW_RIGHT
    UT = COL_UP
    DT = COL_DOWN
    EP = EMPTY_POS
    NE = EMPTY_COUNT
    ONE = (1, 1 << 4, 1 << 8, 1 << 12)  # rank 1 at nibble k of a line
    TWO = (2, 2 << 4, 2 << 8, 2 << 12)  # rank 2 at nibble k of a line
    SP_FOUR = ((1, 0.9), (2, 0.1))
    SP_TWO = ((1, 1.0),)  # 1.0 * x == x exactly, so this is "sum = sum + maxnode(...)"
    tt1 = tts[1]
    tt1_get = tt1.get

    nodes = 0
    hits = 0
    check_at = _INF_NODES
    deadline = float("inf")

    def tick():
        nonlocal check_at
        check_at = nodes + 4096
        if clock() > deadline:
            raise _Timeout()

    def corner(b):
        return corner_term(b, corner_w)

    def chance1(b, _d=1):
        """chance(b, 1): children are maxnode(b', 0) = eval(b')."""
        nonlocal nodes, hits
        nodes += 1
        if nodes >= check_at:
            tick()
        v = tt1_get(b)
        if v is not None:
            hits += 1
            return v
        r0 = b & MASK16
        r1 = (b >> 16) & MASK16
        r2 = (b >> 32) & MASK16
        r3 = b >> 48
        t = T0[r0] | T1[r1] | T2[r2] | T3[r3]
        c0 = t & MASK16
        c1 = (t >> 16) & MASK16
        c2 = (t >> 32) & MASK16
        c3 = t >> 48
        hr0 = H[r0]
        hr1 = H[r1]
        hr2 = H[r2]
        hr3 = H[r3]
        cols = (c0, c1, c2, c3)
        hcols = (H[c0], H[c1], H[c2], H[c3])
        base = hr0 + hr1 + hr2 + hr3 + hcols[0] + hcols[1] + hcols[2] + hcols[3]
        n = NE[r0] + NE[r1] + NE[r2] + NE[r3]
        s = 0.0
        if corner_w == 0 and not (prune > 0 and n >= prune):
            nodes += n + n
            for r, rr, hr in ((0, r0, hr0), (1, r1, hr1), (2, r2, hr2), (3, r3, hr3)):
                e = EP[rr]
                if not e:
                    continue
                brow = base - hr
                o = ONE[r]
                w = TWO[r]
                for c in e:
                    cc = cols[c]
                    x = brow - hcols[c]
                    s = s + 0.9 * (x + H[rr | ONE[c]] + H[cc | o])
                    s = s + 0.1 * (x + H[rr | TWO[c]] + H[cc | w])
        else:
            sp = SP_TWO if (prune > 0 and n >= prune) else SP_FOUR
            nodes += n * len(sp)
            for r, rr, hr in ((0, r0, hr0), (1, r1, hr1), (2, r2, hr2), (3, r3, hr3)):
                e = EP[rr]
                if not e:
                    continue
                brow = base - hr
                for c in e:
                    cc = cols[c]
                    x = brow - hcols[c]
                    for val, p in sp:
                        ev = x + H[rr | (val << (c << 2))] + H[cc | (val << (r << 2))]
                        if corner_w:
                            ev += corner(b | (val << ((r << 4) | (c << 2))))
                        s = s + p * ev
        v = s / n
        tt1[b] = v
        return v

    def chance_n(b, d):
        """chance(b, d) for d >= 2: children are maxnode(b', d-1) >= 1, inlined here."""
        nonlocal nodes, hits
        nodes += 1
        if nodes >= check_at:
            tick()
        tt = tts[d]
        v = tt.get(b)
        if v is not None:
            hits += 1
            return v
        r0 = b & MASK16
        r1 = (b >> 16) & MASK16
        r2 = (b >> 32) & MASK16
        r3 = b >> 48
        t = T0[r0] | T1[r1] | T2[r2] | T3[r3]
        c0 = t & MASK16
        c1 = (t >> 16) & MASK16
        c2 = (t >> 32) & MASK16
        c3 = t >> 48
        up = U0[c0] | U1[c1] | U2[c2] | U3[c3]
        down = D0[c0] | D1[c1] | D2[c2] | D3[c3]
        left = L0[r0] | L1[r1] | L2[r2] | L3[r3]
        right = R0[r0] | R1[r1] | R2[r2] | R3[r3]
        cols = (c0, c1, c2, c3)
        n = NE[r0] + NE[r1] + NE[r2] + NE[r3]
        sp = SP_TWO if (prune > 0 and n >= prune) else SP_FOUR
        nodes += n * len(sp)
        dm = d - 1
        sub = chance1 if dm == 1 else chance_n
        s = 0.0
        for r, rr in ((0, r0), (1, r1), (2, r2), (3, r3)):
            e = EP[rr]
            if not e:
                continue
            Lr = LT[r]
            Rr = RT[r]
            left_x = left ^ Lr[rr]
            right_x = right ^ Rr[rr]
            rs = r << 2
            cs0 = r << 4
            for c in e:
                cc = cols[c]
                Uc = UT[c]
                Dc = DT[c]
                up_x = up ^ Uc[cc]
                down_x = down ^ Dc[cc]
                cs = c << 2
                for val, p in sp:
                    b2 = b | (val << (cs0 | cs))
                    rr2 = rr | (val << cs)
                    cc2 = cc | (val << rs)
                    best = 0.0
                    m = up_x | Uc[cc2]
                    if m != b2:
                        x = sub(m, dm)
                        if x > best:
                            best = x
                    m = down_x | Dc[cc2]
                    if m != b2:
                        x = sub(m, dm)
                        if x > best:
                            best = x
                    m = left_x | Lr[rr2]
                    if m != b2:
                        x = sub(m, dm)
                        if x > best:
                            best = x
                    m = right_x | Rr[rr2]
                    if m != b2:
                        x = sub(m, dm)
                        if x > best:
                            best = x
                    s = s + p * best
        v = s / n
        tt[b] = v
        return v

    def chance(b, d):
        return chance1(b) if d == 1 else chance_n(b, d)

    def reset(dl):
        nonlocal nodes, hits, check_at, deadline
        nodes = 0
        hits = 0
        deadline = dl
        check_at = _INF_NODES if dl == float("inf") else 4096

    def set_deadline(dl):
        nonlocal check_at, deadline
        deadline = dl
        check_at = _INF_NODES if dl == float("inf") else nodes + 4096

    def counters():
        return nodes, hits

    class Core:
        pass

    core = Core()
    core.chance = chance
    core.reset = reset
    core.set_deadline = set_deadline
    core.counters = counters
    return core


class ExpectimaxSearch:
    def __init__(self, config=None) -> None:
        self.config = ExpectimaxConfig.from_dict(config)
        self.weights = self.config.weights
        self.table = line_table(self.weights)
        self.corner = self.weights["corner"]
        c = self.config
        top = max(c.max_depth, c.depth if c.depth != "auto" else 0)
        self._tts = [{} for _ in range(top + 1)]
        self._tt_cap = max(1, int((1 << self.config.tt_bits) * 0.75))
        self._clock = time.perf_counter
        self._core = _build_core(self.table, self.corner, self.config.four_prune_empties, self._tts, self._clock)

    # ------------------------------------------------------------------ helpers
    def evaluate(self, b: int) -> int:
        return evaluate(b, self.table, self.corner)

    def breakdown(self, b: int) -> dict:
        return breakdown(b, self.weights, self.table)

    def depth_for(self, b: int) -> int:
        c = self.config
        if c.depth != "auto":
            return c.depth
        m = RANK_MASK
        mask = (m[b & MASK16] | m[(b >> 16) & MASK16] | m[(b >> 32) & MASK16] | m[b >> 48]) & ~1
        distinct = bin(mask).count("1")
        return max(c.min_depth, min(c.max_depth, distinct - 2))

    def tt_size(self) -> int:
        return sum(len(t) for t in self._tts)

    def clear(self) -> None:
        for t in self._tts:
            t.clear()

    def _root(self, b: int, depth: int):
        chance = self._core.chance
        move = None
        value = float("-inf")
        values = [None, None, None, None]
        for d, m in enumerate(moves4(b)):
            if m == b:
                continue
            v = chance(m, depth)
            values[d] = v
            if v > value:
                value = v
                move = d
        return move, value, values

    # ------------------------------------------------------------------ search
    def search(self, b: int) -> SearchResult:
        clock = self._clock
        start = clock()
        core = self._core
        if self.tt_size() > self._tt_cap:
            self.clear()
        budget = self.config.time_budget_ms or 0
        if budget <= 0:
            core.reset(float("inf"))
            depth = self.depth_for(b)
            r = self._root(b, depth)
            return self._result(r, depth, start, True, [depth])

        # Iterative deepening: keep the deepest completed iteration.
        core.reset(float("inf"))  # depth 1 always completes
        best = self._root(b, 1)
        depth = 1
        completed = [1]
        core.set_deadline(start + budget / 1000.0)
        for d in range(2, self.config.max_depth + 1):
            try:
                best = self._root(b, d)
            except _Timeout:
                break
            depth = d
            completed.append(d)
        core.set_deadline(float("inf"))
        return self._result(best, depth, start, False, completed)

    def _result(self, r, depth, start, deterministic, completed) -> SearchResult:
        move, value, values = r
        nodes, hits = self._core.counters()
        return SearchResult(
            move=move,
            value=value,
            values=values,
            depth=depth,
            nodes=nodes,
            tt_hits=hits,
            tt_size=self.tt_size(),
            time_us=int((self._clock() - start) * 1e6 + 0.5),
            deterministic=deterministic,
            completed_depths=completed,
        )
