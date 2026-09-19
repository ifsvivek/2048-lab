"""SPEC §6 — the game lifecycle."""

from __future__ import annotations

from .board import DIRECTION_LETTERS, board_to_hex, is_over, max_tile, move_in_place, spawn
from .hashing import board_hash, hash_hex, history_step
from .rng import Rng

SPEC_VERSION = 1


class StepResult:
    """Outcome of an applied move: direction, score gained and the spawned tile ``(index, exponent)``."""

    __slots__ = ("dir", "gained", "spawn")

    def __init__(self, dir: int, gained: int, spawn) -> None:
        self.dir = dir
        self.gained = gained
        self.spawn = spawn

    def __repr__(self) -> str:
        return f"StepResult(dir={self.dir}, gained={self.gained}, spawn={self.spawn})"


class Game:
    __slots__ = ("seed", "board", "score", "move_count", "_rng", "_hash", "_letters")

    def __init__(self, seed: int) -> None:
        self.seed = int(seed) & 0xFFFFFFFF
        self._rng = Rng.from_seed(self.seed)
        self.board = [0] * 16
        spawn(self.board, self._rng)
        spawn(self.board, self._rng)
        self.score = 0
        self.move_count = 0
        self._hash = board_hash(self.board)
        self._letters: list[str] = []

    def apply(self, direction: int):
        """Apply a move. Returns a StepResult, or None (changing nothing) if the move is invalid."""
        board = self.board
        gained = move_in_place(board, direction)
        if gained < 0:
            return None
        self.score += gained
        self.move_count += 1
        s = spawn(board, self._rng)
        self._hash = history_step(self._hash, board, direction)
        self._letters.append(DIRECTION_LETTERS[direction])
        return StepResult(direction, gained, s)

    @property
    def over(self) -> bool:
        return is_over(self.board)

    @property
    def history_hash(self) -> str:
        return hash_hex(self._hash)

    @property
    def moves(self) -> str:
        return "".join(self._letters)

    @property
    def max_tile(self) -> int:
        return max_tile(self.board)

    def rng_state(self) -> list[int]:
        return self._rng.state()

    def snapshot(self) -> dict:
        return {
            "board": board_to_hex(self.board),
            "score": self.score,
            "moveCount": self.move_count,
            "maxTile": max_tile(self.board),
            "over": self.over,
            "historyHash": self.history_hash,
        }
