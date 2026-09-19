"""The common agent interface and the built-in agents (random, greedy, expectimax).

Every agent implements ``decide(observation) -> Decision``; the HTTP agent
protocol (spec/AGENT_PROTOCOL.md) is a direct serialisation of this contract.
"""

from __future__ import annotations

import time

from ..board import DIRECTION_NAMES, board_to_hex, board_to_matrix, valid_moves
from ..game import SPEC_VERSION
from ..rng import Rng
from .bitboard import EMPTY_COUNT, MASK16, from_board, moves4
from .expectimax import ExpectimaxSearch

_clock = time.perf_counter


class GameMeta:
    __slots__ = ("seed", "spec_version", "game_id")

    def __init__(self, seed: int, spec_version: int = SPEC_VERSION, game_id: str | None = None) -> None:
        self.seed = seed
        self.spec_version = spec_version
        self.game_id = game_id


class Observation:
    """What an agent sees: the exponent board (row-major), score, move count and game metadata."""

    __slots__ = ("board", "score", "move_count", "meta")

    def __init__(self, board, score: int = 0, move_count: int = 0, meta: GameMeta | None = None) -> None:
        self.board = board
        self.score = score
        self.move_count = move_count
        self.meta = meta if meta is not None else GameMeta(0)


class Decision:
    """A chosen direction (0-3) plus free-form metrics (camelCase keys, JSON-serialisable)."""

    __slots__ = ("move", "metrics")

    def __init__(self, move: int, metrics: dict) -> None:
        self.move = move
        self.metrics = metrics

    def __repr__(self) -> str:
        return f"Decision(move={DIRECTION_NAMES[self.move]!r}, metrics={self.metrics!r})"


class Agent:
    """Agent protocol. Subclasses set ``descriptor`` and implement ``decide``."""

    descriptor: dict = {}

    def reset(self, meta: GameMeta) -> None:  # noqa: B027 - optional hook
        """Called once per game before the first decision."""

    def decide(self, obs: Observation) -> Decision:
        raise NotImplementedError


def _descriptor(id_: str, name: str, config: dict | None = None) -> dict:
    d = {"id": id_, "name": name, "version": "1.0.0", "kind": "builtin", "language": "python"}
    if config is not None:
        d["config"] = config
    return d


class RandomAgent(Agent):
    """SPEC §10 reference random agent."""

    def __init__(self) -> None:
        self.descriptor = _descriptor("builtin/random", "Random")
        self.rng = Rng.from_seed(0)

    def reset(self, meta: GameMeta) -> None:
        self.rng = Rng.from_seed((meta.seed ^ 0xA5A5A5A5) & 0xFFFFFFFF)

    def decide(self, obs: Observation) -> Decision:
        t = _clock()
        valid = valid_moves(obs.board)
        move = valid[self.rng.below(len(valid))]
        return Decision(move, {"timeUs": int((_clock() - t) * 1e6 + 0.5), "deterministic": True})


class GreedyAgent(Agent):
    """One-ply greedy: maximise empty cells after the move, ties to the lower direction."""

    def __init__(self) -> None:
        self.descriptor = _descriptor("builtin/greedy", "Greedy")

    def decide(self, obs: Observation) -> Decision:
        t = _clock()
        b = from_board(obs.board)
        valid = valid_moves(obs.board)
        best = valid[0] if valid else 0
        best_score = -1
        ec = EMPTY_COUNT
        for d, m in enumerate(moves4(b)):
            if m == b:
                continue
            empty = ec[m & MASK16] + ec[(m >> 16) & MASK16] + ec[(m >> 32) & MASK16] + ec[m >> 48]
            if empty > best_score:
                best_score = empty
                best = d
        return Decision(best, {"timeUs": int((_clock() - t) * 1e6 + 0.5), "deterministic": True})


class ExpectimaxAgent(Agent):
    def __init__(self, config: dict | None = None, name: str = "Expectimax") -> None:
        self.search = ExpectimaxSearch(config)
        self.descriptor = _descriptor("builtin/expectimax", name, self.search.config.to_dict())
        self.last_result = None

    def decide(self, obs: Observation) -> Decision:
        b = from_board(obs.board)
        r = self.search.search(b)
        self.last_result = r
        move = r.move
        if move is None:
            valid = valid_moves(obs.board)
            move = valid[0] if valid else 0
        return Decision(
            move,
            {
                "depth": r.depth,
                "nodes": r.nodes,
                "ttHits": r.tt_hits,
                "ttSize": r.tt_size,
                "timeUs": r.time_us,
                "values": r.values,
                "heuristic": self.search.breakdown(b),
                "deterministic": r.deterministic,
                "completedDepths": r.completed_depths,
            },
        )


BUILTIN_AGENTS = ("random", "greedy", "expectimax")


def create_builtin_agent(agent_id: str, config: dict | None = None) -> Agent:
    if agent_id == "random":
        return RandomAgent()
    if agent_id == "greedy":
        return GreedyAgent()
    if agent_id == "expectimax":
        return ExpectimaxAgent(config or {})
    raise ValueError(f"unknown agent {agent_id!r} (expected one of {', '.join(BUILTIN_AGENTS)})")


def to_agent_request(obs: Observation) -> dict:
    """Wire format sent to remote agents (AGENT_PROTOCOL.md AgentRequest)."""
    req = {
        "seed": obs.meta.seed,
        "specVersion": obs.meta.spec_version,
        "board": board_to_matrix(obs.board),
        "boardHex": board_to_hex(obs.board),
        "score": obs.score,
        "moveCount": obs.move_count,
        "validMoves": [DIRECTION_NAMES[d] for d in valid_moves(obs.board)],
    }
    if obs.meta.game_id is not None:
        req = {"gameId": obs.meta.game_id, **req}
    return req
