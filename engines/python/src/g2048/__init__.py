"""Deterministic 2048 engine (spec v1) — Python port."""

from .board import DIRECTION_LETTERS, DIRECTION_NAMES, board_from_hex, board_to_hex, move, valid_moves
from .game import SPEC_VERSION, Game
from .replay import ReplayError, simulate, verify
from .rng import Rng, mix32

ENGINE_VERSION = "1.0.0"

__all__ = [
    "DIRECTION_LETTERS",
    "DIRECTION_NAMES",
    "ENGINE_VERSION",
    "Game",
    "ReplayError",
    "Rng",
    "SPEC_VERSION",
    "board_from_hex",
    "board_to_hex",
    "mix32",
    "move",
    "simulate",
    "valid_moves",
    "verify",
]
