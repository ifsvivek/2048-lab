"""Canonical AI (spec/AI.md): bitboard, heuristic, expectimax and built-in agents."""

from .agents import (
    Agent,
    Decision,
    ExpectimaxAgent,
    GameMeta,
    GreedyAgent,
    Observation,
    RandomAgent,
    create_builtin_agent,
)
from .expectimax import CANONICAL_EXPECTIMAX, ExpectimaxConfig, ExpectimaxSearch, SearchResult
from .heuristic import HEURISTIC_V1

__all__ = [
    "Agent",
    "CANONICAL_EXPECTIMAX",
    "Decision",
    "ExpectimaxAgent",
    "ExpectimaxConfig",
    "ExpectimaxSearch",
    "GameMeta",
    "GreedyAgent",
    "HEURISTIC_V1",
    "Observation",
    "RandomAgent",
    "SearchResult",
    "create_builtin_agent",
]
