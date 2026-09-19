# 2048 Canonical Game Specification — version 1

This document is the single source of truth for game behaviour. Every engine
(TypeScript, Rust, Go, Python, and any future port) MUST implement it exactly
and MUST pass every fixture in `spec/fixtures/`. When prose and fixtures
disagree, the fixtures win and the prose is a bug.

`SPEC_VERSION = 1`. Any change that alters an observable outcome for an
existing `(seed, moves)` pair requires a new spec version.

All integer arithmetic below is **unsigned 32-bit with wrap-around** unless
stated otherwise. `>>>` is a logical shift, `rotl(x, k) = (x << k) | (x >>> (32 - k))`,
`imul` is the low 32 bits of the product.

---

## 1. Board

* 4×4 grid, 16 cells, **row-major**: cell index `i = row * 4 + col`, row 0 is the top,
  col 0 is the left.
* A cell stores an **exponent** `e`: `0` = empty, otherwise the tile value is `2^e`.
  Engines MUST support exponents `1..17` (tile 131072 is the theoretical maximum).
* Canonical textual encoding (`boardHex`): 16 lowercase characters, one per cell in
  index order, using the digits `0-9a-z` for exponents `0..35`
  (`"0000000000000000"` is the empty board, `"b"` = 2048).

## 2. Directions

| Index | Name  | Letter | Tiles slide toward |
|------:|-------|:------:|--------------------|
| 0     | up    | `U`    | row 0              |
| 1     | down  | `D`    | row 3              |
| 2     | left  | `L`    | col 0              |
| 3     | right | `R`    | col 3              |

Whenever a procedure iterates over directions it uses this order. Ties between
directions are always broken in favour of the **lower index**.

## 3. Line merge

A move processes four independent **lines**. A line is the list of four cells
ordered starting from the edge the tiles slide toward:

* `up`:    for each col `c`: cells `(0,c),(1,c),(2,c),(3,c)`
* `down`:  for each col `c`: cells `(3,c),(2,c),(1,c),(0,c)`
* `left`:  for each row `r`: cells `(r,0),(r,1),(r,2),(r,3)`
* `right`: for each row `r`: cells `(r,3),(r,2),(r,1),(r,0)`

Merging one line `a[0..3]`:

```
tiles  = non-zero entries of a, in order
out    = []
gained = 0
i = 0
while i < len(tiles):
    if i + 1 < len(tiles) and tiles[i] == tiles[i+1]:
        out.append(tiles[i] + 1)
        gained += 2 ** (tiles[i] + 1)
        i += 2
    else:
        out.append(tiles[i])
        i += 1
pad out with 0 to length 4
```

A merged tile never merges again in the same move (`[1,1,1,1] -> [2,2,0,0]`,
`[1,1,2,0] -> [2,2,0,0]`, `[2,1,1,0] -> [2,2,0,0]`).

A move is **valid** iff it changes at least one cell. The score gained is the
sum of `gained` over the four lines.

## 4. Random number generator

### 4.1 Seed expansion — `mix32`

The seed is an unsigned 32-bit integer. The four generator state words are
produced by a SplitMix-style sequence using the MurmurHash3 finaliser:

```
x = seed
repeat 4 times (k = 0..3):
    x = x + 0x9E3779B9
    z = x
    z = imul(z ^ (z >>> 16), 0x85EBCA6B)
    z = imul(z ^ (z >>> 13), 0xC2B2AE35)
    s[k] = z ^ (z >>> 16)
if s[0] == s[1] == s[2] == s[3] == 0: s[0] = 1
```

### 4.2 Generator — xoshiro128**

```
next():
    result = imul(rotl(imul(s[1], 5), 7), 9)
    t = s[1] << 9
    s[2] ^= s[0]
    s[3] ^= s[1]
    s[1] ^= s[2]
    s[0] ^= s[3]
    s[2] ^= t
    s[3] = rotl(s[3], 11)
    return result
```

### 4.3 Bounded integers — `below(n)`, `1 <= n <= 2^32`

Unbiased rejection sampling:

```
below(n):
    limit = 2^32 - (2^32 mod n)       # computed in 64-bit or float64 arithmetic
    loop:
        x = next()
        if x < limit: return x mod n
```

For `n` that divides `2^32` (1, 2, 4, 8, 16) no value is ever rejected.

## 5. Tile spawning

```
spawn(board, rng):
    empties = indices i with board[i] == 0, ascending
    if empties is empty: return (no-op)
    i = empties[rng.below(len(empties))]
    board[i] = 2 if rng.below(10) == 0 else 1       # 10% fours, 90% twos
```

Exactly this order: position first, then value.

## 6. Game lifecycle

```
new_game(seed):
    board = 16 zeros, score = 0, moves = 0
    rng   = xoshiro128**(mix32(seed))
    spawn(board, rng); spawn(board, rng)

apply(game, dir):
    (board', gained) = move(game.board, dir)
    if board' == game.board: reject — state (including RNG) is unchanged
    game.board = board'
    game.score += gained
    game.moves += 1
    spawn(game.board, game.rng)

over(game) = no direction is valid
```

Rejected moves are **never** recorded in a replay; a replay's move list
contains only valid moves. Replaying a move list that contains an invalid move
is an error (`INVALID_MOVE_AT <n>`).

## 7. State hash

`fnv1a32` over a byte sequence: `h = 0x811C9DC5; for b: h = imul(h ^ b, 0x01000193)`.

* `boardHash(board)` = `fnv1a32` of the 16 exponent bytes in index order.
* `historyHash(game)` is a running hash: starts at `boardHash(initial board)`,
  and after every applied move `h = fnv1a32(bytes(h as 4 little-endian bytes) ++
  16 board bytes ++ [direction index])`.

`historyHash` is lowercase 8-digit hex in all serialised forms. Two
implementations that agree on `historyHash` agree on the entire board history.

## 8. Replay format

```jsonc
{
  "specVersion": 1,
  "seed": 3141592653,
  "moves": "ULLRDU...",              // one letter per valid move (§2)
  "final": {
    "board": "0123...",              // boardHex
    "score": 20480,
    "moveCount": 1034,
    "maxTile": 2048,
    "over": true,
    "historyHash": "9ad0c1e2"
  },
  "timing": [12, 9, 30, ...],        // optional: per-move decision time, µs (integer)
  "agent":   { "id": "...", "name": "expectimax", "version": "1.0.0", "config": { } },
  "runtime": { "language": "typescript", "runtime": "v8", "version": "...", "platform": "browser" }
}
```

A replay is valid iff replaying `moves` from `new_game(seed)` produces exactly
`final`. Servers MUST re-simulate before accepting a replay; client-supplied
`final` values are never trusted.

## 9. Identifiers

* **Seed** — uint32, generated from a CSPRNG when not supplied.
* **Game ID** — a ULID (26 chars, Crockford base32, time-sortable).
* **Replay code** — 12 symbols from the alphabet
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 symbols; no `0 1 I O`), displayed in
  groups of four: `A7KF-29LM-XQ4P` (60 bits of entropy). Input is normalised by
  upper-casing and removing every character that is not in `[A-Z0-9]`.

## 10. Reference random agent (for throughput and cross-language checks)

```
agent_rng = xoshiro128**(mix32(seed XOR 0xA5A5A5A5))
choose(game):
    valid = directions d (in index order) for which move(board, d) is valid
    return valid[agent_rng.below(len(valid))]
```

Playing this agent to completion from `new_game(seed)` is fully deterministic
and is used by the `random-*` benchmark suites and the `games` fixtures.

## 11. Canonical expectimax (AI determinism)

The built-in search agent has a canonical, deterministic mode so that different
language ports make **identical decisions** and their benchmark results are
directly comparable. See `spec/AI.md`.
