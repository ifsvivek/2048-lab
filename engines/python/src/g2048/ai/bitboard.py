"""AI.md §1 — 64-bit bitboard held in a Python int.

Cell ``i`` occupies bits ``4i .. 4i+3``; row ``r`` is ``(b >> 16r) & 0xFFFF`` with
column 0 in the lowest nibble. Moves go through 65536-entry line tables with
saturating merges (15 + 15 = 15).

Hot-path tables (all lists of 65536 ints, indexed by a 16-bit line value):

* ``ROW_LEFT[r][v]`` / ``ROW_RIGHT[r][v]`` — row ``r`` moved left/right, already
  shifted into place (``<< 16r``).
* ``TRANSPOSE[r][v]`` — row ``r`` scattered into the transposed board, so that
  ``T = TRANSPOSE[0][r0] | ... | TRANSPOSE[3][r3]`` has column ``c`` as its row ``c``.
* ``COL_UP[c][v]`` / ``COL_DOWN[c][v]`` — column ``c`` (as a line value, nibble k
  = row k) moved up/down and scattered back into column ``c`` of a board.
"""

from __future__ import annotations

MASK16 = 0xFFFF
MASK64 = 0xFFFFFFFFFFFFFFFF


def _reverse(v: int) -> int:
    return ((v & 0xF) << 12) | (((v >> 4) & 0xF) << 8) | (((v >> 8) & 0xF) << 4) | ((v >> 12) & 0xF)


def _build_line_tables():
    toward_low = [0] * 65536
    for v in range(65536):
        tiles = [x for x in (v & 0xF, (v >> 4) & 0xF, (v >> 8) & 0xF, v >> 12) if x]
        out = []
        i = 0
        n = len(tiles)
        while i < n:
            if i + 1 < n and tiles[i] == tiles[i + 1]:
                out.append(min(tiles[i] + 1, 15))
                i += 2
            else:
                out.append(tiles[i])
                i += 1
        res = 0
        for k, x in enumerate(out):
            res |= x << (4 * k)
        toward_low[v] = res
    toward_high = [_reverse(toward_low[_reverse(v)]) for v in range(65536)]
    return toward_low, toward_high


#: Slide toward the low nibble ("left" for rows, "up" for columns).
LINE_TOWARD_LOW, LINE_TOWARD_HIGH = _build_line_tables()

#: A line value placed as column 0: nibble k goes to bit 16k (row k).
SPREAD = [
    (v & 0xF) | (((v >> 4) & 0xF) << 16) | (((v >> 8) & 0xF) << 32) | ((v >> 12) << 48) for v in range(65536)
]

ROW_LEFT = tuple([x << (16 * r) for x in LINE_TOWARD_LOW] for r in range(4))
ROW_RIGHT = tuple([x << (16 * r) for x in LINE_TOWARD_HIGH] for r in range(4))
TRANSPOSE = tuple([x << (4 * r) for x in SPREAD] for r in range(4))
COL_UP = tuple([SPREAD[x] << (4 * c) for x in LINE_TOWARD_LOW] for c in range(4))
COL_DOWN = tuple([SPREAD[x] << (4 * c) for x in LINE_TOWARD_HIGH] for c in range(4))

#: EMPTY_POS[v] = positions (ascending) of the zero nibbles of line value v.
EMPTY_POS = [tuple(k for k in range(4) if (v >> (4 * k)) & 0xF == 0) for v in range(65536)]

#: EMPTY_COUNT[v] = number of zero nibbles of line value v.
EMPTY_COUNT = [len(e) for e in EMPTY_POS]

#: RANK_MASK[v] = bitmask of the ranks present in line value v (bit 0 = empty).
RANK_MASK = [
    (1 << (v & 0xF)) | (1 << ((v >> 4) & 0xF)) | (1 << ((v >> 8) & 0xF)) | (1 << (v >> 12)) for v in range(65536)
]


def from_board(board) -> int:
    """Convert a game board (16 exponents) to a bitboard, clamping ranks above 15."""
    b = 0
    for i, e in enumerate(board):
        b |= (e if e < 15 else 15) << (4 * i)
    return b


def to_board(b: int) -> list[int]:
    return [(b >> (4 * i)) & 0xF for i in range(16)]


def nibble(b: int, i: int) -> int:
    return (b >> (4 * i)) & 0xF


def row(b: int, r: int) -> int:
    return (b >> (16 * r)) & MASK16


def column(b: int, c: int) -> int:
    s = 4 * c
    return ((b >> s) & 0xF) | (((b >> (16 + s)) & 0xF) << 4) | (((b >> (32 + s)) & 0xF) << 8) | (((b >> (48 + s)) & 0xF) << 12)


def transpose(b: int) -> int:
    T0, T1, T2, T3 = TRANSPOSE
    return T0[b & MASK16] | T1[(b >> 16) & MASK16] | T2[(b >> 32) & MASK16] | T3[b >> 48]


def moves4(b: int) -> tuple[int, int, int, int]:
    """Boards after up, down, left, right (a move is valid iff the result differs from ``b``)."""
    r0 = b & MASK16
    r1 = (b >> 16) & MASK16
    r2 = (b >> 32) & MASK16
    r3 = b >> 48
    T0, T1, T2, T3 = TRANSPOSE
    t = T0[r0] | T1[r1] | T2[r2] | T3[r3]
    c0 = t & MASK16
    c1 = (t >> 16) & MASK16
    c2 = (t >> 32) & MASK16
    c3 = t >> 48
    U0, U1, U2, U3 = COL_UP
    D0, D1, D2, D3 = COL_DOWN
    L0, L1, L2, L3 = ROW_LEFT
    R0, R1, R2, R3 = ROW_RIGHT
    return (
        U0[c0] | U1[c1] | U2[c2] | U3[c3],
        D0[c0] | D1[c1] | D2[c2] | D3[c3],
        L0[r0] | L1[r1] | L2[r2] | L3[r3],
        R0[r0] | R1[r1] | R2[r2] | R3[r3],
    )


def move(b: int, d: int) -> int:
    return moves4(b)[d]


def distinct_ranks(b: int) -> int:
    m = RANK_MASK
    mask = (m[b & MASK16] | m[(b >> 16) & MASK16] | m[(b >> 32) & MASK16] | m[b >> 48]) & ~1
    return bin(mask).count("1")


def max_rank(b: int) -> int:
    m = RANK_MASK
    return (m[b & MASK16] | m[(b >> 16) & MASK16] | m[(b >> 32) & MASK16] | m[b >> 48]).bit_length() - 1


def empty_count(b: int) -> int:
    e = EMPTY_COUNT
    return e[b & MASK16] + e[(b >> 16) & MASK16] + e[(b >> 32) & MASK16] + e[b >> 48]


_HEX = "0123456789abcdef"


def to_hex(b: int) -> str:
    return "".join(_HEX[(b >> (4 * i)) & 0xF] for i in range(16))


def from_hex(s: str) -> int:
    from ..board import board_from_hex

    return from_board(board_from_hex(s))
