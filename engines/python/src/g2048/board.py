"""SPEC §1–§3, §5 — board encoding, line merge, moves and spawning.

A board is a list of 16 exponents, row-major (cell ``i = row * 4 + col``).
"""

from __future__ import annotations

UP, DOWN, LEFT, RIGHT = 0, 1, 2, 3
DIRECTIONS = (UP, DOWN, LEFT, RIGHT)
DIRECTION_LETTERS = "UDLR"
DIRECTION_NAMES = ("up", "down", "left", "right")

#: LINES[dir][line] = the four cell indices, starting at the edge tiles slide toward.
LINES = (
    tuple((c, 4 + c, 8 + c, 12 + c) for c in range(4)),
    tuple((12 + c, 8 + c, 4 + c, c) for c in range(4)),
    tuple((4 * r, 4 * r + 1, 4 * r + 2, 4 * r + 3) for r in range(4)),
    tuple((4 * r + 3, 4 * r + 2, 4 * r + 1, 4 * r) for r in range(4)),
)

HEX = "0123456789abcdefghijklmnopqrstuvwxyz"
_HEX_INDEX = {ch: i for i, ch in enumerate(HEX)}


def empty_board() -> list[int]:
    return [0] * 16


def board_to_hex(board) -> str:
    return "".join([HEX[e] for e in board])


def board_from_hex(s: str) -> list[int]:
    if len(s) != 16:
        raise ValueError(f"boardHex must be 16 chars, got {len(s)}")
    out = []
    for ch in s:
        v = _HEX_INDEX.get(ch.lower())
        if v is None:
            raise ValueError(f"invalid boardHex character {ch!r}")
        out.append(v)
    return out


def board_to_matrix(board) -> list[list[int]]:
    """Tile values (0 = empty) as ``m[row][col]``."""
    return [[0 if board[r * 4 + c] == 0 else 1 << board[r * 4 + c] for c in range(4)] for r in range(4)]


def board_from_matrix(m) -> list[int]:
    if len(m) != 4 or any(len(row) != 4 for row in m):
        raise ValueError("board matrix must be 4x4")
    out = []
    for row in m:
        for v in row:
            v = int(v)
            if v == 0:
                out.append(0)
            elif v >= 2 and v & (v - 1) == 0:
                out.append(v.bit_length() - 1)
            else:
                raise ValueError(f"invalid tile value {v}")
    return out


def max_exponent(board) -> int:
    return max(board)


def max_tile(board) -> int:
    e = max(board)
    return 0 if e == 0 else 1 << e


def empty_count(board) -> int:
    return board.count(0)


# --------------------------------------------------------------------------- line merge
# Memoised merge of one line keyed by the packed exponents (6 bits per cell).
# Value: (o0, o1, o2, o3, gained, changed)

_MERGE: dict = {}


def merge_line(a: int, b: int, c: int, d: int) -> tuple:
    """SPEC §3 merge of one line ordered toward the slide edge."""
    key = a | (b << 6) | (c << 12) | (d << 18)
    r = _MERGE.get(key)
    if r is None:
        tiles = [x for x in (a, b, c, d) if x]
        out = []
        gained = 0
        i = 0
        n = len(tiles)
        while i < n:
            if i + 1 < n and tiles[i] == tiles[i + 1]:
                e = tiles[i] + 1
                out.append(e)
                gained += 1 << e
                i += 2
            else:
                out.append(tiles[i])
                i += 1
        out += [0] * (4 - len(out))
        r = (out[0], out[1], out[2], out[3], gained, (out[0], out[1], out[2], out[3]) != (a, b, c, d))
        _MERGE[key] = r
    return r


def move_in_place(board: list, d: int) -> int:
    """Apply direction ``d`` in place. Returns the score gained, or -1 if invalid (board untouched)."""
    gained = 0
    changed = False
    get = _MERGE.get
    for i0, i1, i2, i3 in LINES[d]:
        a = board[i0]
        b = board[i1]
        c = board[i2]
        e = board[i3]
        r = get(a | (b << 6) | (c << 12) | (e << 18))
        if r is None:
            r = merge_line(a, b, c, e)
        if r[5]:
            board[i0] = r[0]
            board[i1] = r[1]
            board[i2] = r[2]
            board[i3] = r[3]
            gained += r[4]
            changed = True
    return gained if changed else -1


def move(board, d: int) -> tuple:
    """Return ``(board', gained, changed)``. An invalid move returns the input board unchanged."""
    b = list(board)
    g = move_in_place(b, d)
    if g < 0:
        return board, 0, False
    return b, g, True


def can_move(board, d: int) -> bool:
    for i0, i1, i2, i3 in LINES[d]:
        a = board[i0]
        b = board[i1]
        c = board[i2]
        e = board[i3]
        if b and (a == 0 or a == b):
            return True
        if c and (b == 0 or b == c):
            return True
        if e and (c == 0 or c == e):
            return True
    return False


def valid_moves(board) -> list[int]:
    return [d for d in DIRECTIONS if can_move(board, d)]


def is_over(board) -> bool:
    return not (can_move(board, 0) or can_move(board, 1) or can_move(board, 2) or can_move(board, 3))


def spawn(board: list, rng):
    """SPEC §5. Returns ``(index, exponent)`` or ``None`` if the board is full."""
    empties = [i for i, e in enumerate(board) if not e]
    if not empties:
        return None
    index = empties[rng.below(len(empties))]
    exponent = 2 if rng.below(10) == 0 else 1
    board[index] = exponent
    return (index, exponent)


def parse_direction(value) -> int:
    """Accept 0-3, 'up'/'down'/'left'/'right' or 'U'/'D'/'L'/'R'."""
    if isinstance(value, int) and not isinstance(value, bool):
        if 0 <= value <= 3:
            return value
        raise ValueError(f"invalid direction {value}")
    s = str(value).strip().lower()
    if s in DIRECTION_NAMES:
        return DIRECTION_NAMES.index(s)
    if len(s) == 1 and s.upper() in DIRECTION_LETTERS:
        return DIRECTION_LETTERS.index(s.upper())
    raise ValueError(f"invalid direction {value!r}")
