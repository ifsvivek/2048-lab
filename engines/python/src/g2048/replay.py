"""SPEC §6/§8 — replay simulation and verification."""

from __future__ import annotations

from .board import DIRECTION_LETTERS
from .game import SPEC_VERSION, Game

INVALID_MOVE_AT = "INVALID_MOVE_AT"
BAD_LETTER = "BAD_LETTER"
SPEC_VERSION_ERROR = "SPEC_VERSION"
FINAL_MISMATCH = "FINAL_MISMATCH"

_LETTER = {ch: i for i, ch in enumerate(DIRECTION_LETTERS)}


class ReplayError(Exception):
    def __init__(self, code: str, message: str, move_index: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.move_index = move_index


def simulate(seed: int, moves: str) -> Game:
    """Re-simulate ``moves`` from ``new_game(seed)``; raises ReplayError on a bad letter or invalid move."""
    game = Game(seed)
    for i, ch in enumerate(moves):
        d = _LETTER.get(ch)
        if d is None:
            raise ReplayError(BAD_LETTER, f"bad move letter {ch!r} at {i}", i)
        if game.apply(d) is None:
            raise ReplayError(INVALID_MOVE_AT, f"INVALID_MOVE_AT {i}", i)
    return game


def verify(replay: dict) -> dict:
    """Verify a replay dict (specVersion, seed, moves, optional final); returns the authoritative final snapshot."""
    sv = replay.get("specVersion")
    if sv != SPEC_VERSION:
        raise ReplayError(SPEC_VERSION_ERROR, f"unsupported specVersion {sv}")
    snap = simulate(replay["seed"], replay["moves"]).snapshot()
    final = replay.get("final")
    if final:
        for key in ("board", "score", "moveCount", "historyHash"):
            if key in final and final[key] is not None and final[key] != snap[key]:
                raise ReplayError(FINAL_MISMATCH, f"final.{key} mismatch: claimed {final[key]}, actual {snap[key]}")
    return snap
