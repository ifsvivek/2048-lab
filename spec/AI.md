# Canonical Expectimax — AI specification v1

The built-in search agent is specified precisely enough that every language
port makes the **same decision with the same value** for the same board and
configuration. This is what makes cross-runtime benchmarks meaningful: when the
Rust and Python ports play seed `42`, they play the *same game*, so the only
difference measured is speed.

Fixtures: `spec/fixtures/ai.json`.

## 1. Bitboard

The search operates on a 64-bit board: cell `i` (see SPEC §1) occupies bits
`4i .. 4i+3`. Row `r` is therefore the 16-bit value `(board >> 16r) & 0xFFFF`
whose lowest nibble is column 0. Exponents above 15 are clamped to 15 when
converting a game board to a bitboard (only relevant past the 32768 tile), and
bitboard moves saturate: merging two rank-15 tiles yields rank 15. This only
affects search, never the game itself.

A **line value** is a 16-bit number holding four ranks `r0..r3` (`r0` in the
lowest nibble), ordered like SPEC §3 lines for `left` (rows, left→right) and
`up` (columns, top→bottom).

## 2. Heuristic

The heuristic is the sum of a per-line score over the 4 rows and 4 columns plus
a whole-board corner term. With integer weights every intermediate value is an
integer below 2^53, so results are exact in float64 in every language.

Per line with ranks `r[0..3]`:

```
empty  = count of r[i] == 0
merges = 0; prev = 0; counter = 0
for rank in r:
    if rank == 0: continue
    if prev == rank: counter += 1
    elif counter > 0: merges += 1 + counter; counter = 0
    prev = rank
if counter > 0: merges += 1 + counter

monoL = monoR = 0
for i in 1..3:
    if r[i-1] > r[i]: monoL += r[i-1]^4 - r[i]^4
    else:             monoR += r[i]^4   - r[i-1]^4

sum    = Σ r[i]^3
smooth = Σ |r[i] - r[i+1]| for i in 0..2 where r[i] != 0 and r[i+1] != 0
stable = 1 if empty == 0 and (monoL == 0 or monoR == 0) else 0

line = W.lost + W.empty*empty + W.merges*merges - W.mono*min(monoL, monoR)
       - W.sum*sum - W.smooth*smooth + W.stable*stable
```

Board term:

```
maxRank = max over all 16 cells
corner  = W.corner * maxRank  if any of cells 0, 3, 12, 15 equals maxRank, else 0
eval(b) = Σ line(row r) for r in 0..3  +  Σ line(col c) for c in 0..3  +  corner
```

Canonical weights (`HEURISTIC_V1`):

| weight | value  |
|--------|--------|
| lost   | 200000 |
| empty  | 270    |
| merges | 700    |
| mono   | 47     |
| sum    | 11     |
| smooth | 0      |
| stable | 0      |
| corner | 0      |

`smooth`, `stable` and `corner` are implemented in every port but disabled in
the canonical profile; tuning experiments enable them via configuration. All
weights MUST be integers.

## 3. Search

```
root(b, D):                           # returns best direction or none
    best = none, bestValue = -inf
    for d in 0..3:                    # up, down, left, right
        b' = move(b, d)
        if b' == b: continue
        v = chance(b', D)
        if v > bestValue: best, bestValue = d, v      # strict: ties keep lower index

chance(b, d):                         # d >= 1
    empties = cell indices i (ascending) with nibble i == 0; n = len(empties)
    four = not (P > 0 and n >= P)     # P = config.fourPruneEmpties
    sum = 0.0
    for i in empties:
        if four:
            sum = sum + 0.9 * maxnode(b | (1 << 4i), d - 1)
            sum = sum + 0.1 * maxnode(b | (2 << 4i), d - 1)
        else:
            sum = sum + maxnode(b | (1 << 4i), d - 1)
    return sum / n

maxnode(b, d):
    if d == 0: return eval(b)
    best = 0.0                        # a position with no legal move scores 0
    for d' in 0..3:
        b' = move(b, d'); if b' == b: continue
        best = max(best, chance(b', d))
    return best
```

The products `0.9 * x` and `0.1 * x` are rounded to float64 before the addition
(no fused multiply-add). `sum / n` is a float64 division.

### Depth selection

* `depth: <int>` — fixed depth `D`.
* `depth: "auto"` — `D = clamp(distinct - 2, minDepth, maxDepth)` where
  `distinct` is the number of distinct non-zero ranks on the board.

Canonical profile: `depth: "auto", minDepth: 2, maxDepth: 4, fourPruneEmpties: 0`.

### Transposition table

`chance(b, d)` is a pure function of `(b, d)`, so a transposition table keyed
on the exact pair may cache it at any depth with any replacement policy without
changing results. Implementations are free to choose table size and policy.

### Iterative deepening / time budgets

With `timeBudgetMs > 0` the agent searches `D = 1, 2, …, maxDepth` and returns
the result of the deepest *completed* iteration. This mode is **not**
deterministic and is reported with `deterministic: false` in agent metrics and
benchmark results. Canonical benchmarks never use it.

## 4. Metrics every port reports per decision

`move`, `depth`, `nodes` (maxnode + chance calls), `ttHits`, `ttSize`,
`timeUs`, `values` (per-direction root values, `null` for invalid moves) and the
heuristic breakdown of the current board.
