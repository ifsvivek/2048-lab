import pytest
from conftest import load

from g2048.ai import bitboard as bb
from g2048.ai.agents import ExpectimaxAgent, GameMeta, GreedyAgent, Observation
from g2048.ai.expectimax import ExpectimaxSearch
from g2048.ai.heuristic import breakdown, evaluate, line_features, line_table
from g2048.board import DIRECTION_LETTERS, board_from_hex, valid_moves
from g2048.validate import values_close

FX = load("ai")
WC = FX["weights"]["canonical"]
WA = FX["weights"]["allWeights"]


@pytest.mark.parametrize("case", FX["lines"], ids=[str(c["line"]) for c in FX["lines"]])
def test_line(case):
    v = case["line"]
    assert line_features(v) == case["features"]
    assert line_table(WC)[v] == case["canonical"]
    assert line_table(WA)[v] == case["allWeights"]


@pytest.mark.parametrize("case", FX["evaluations"], ids=[c["board"] for c in FX["evaluations"]])
def test_evaluation(case):
    b = bb.from_hex(case["board"])
    assert evaluate(b, line_table(WC), WC["corner"]) == case["canonical"]
    assert evaluate(b, line_table(WA), WA["corner"]) == case["allWeights"]
    assert ExpectimaxSearch({"weights": WA}).evaluate(b) == case["allWeights"]
    assert breakdown(b, WA)["total"] == case["allWeights"]


@pytest.mark.parametrize("case", FX["bitboardMoves"], ids=[c["board"] for c in FX["bitboardMoves"]])
def test_bitboard_moves(case):
    b = bb.from_hex(case["board"])
    for d, res in enumerate(case["results"]):
        m = bb.move(b, d)
        assert (m != b) == res["changed"]
        assert bb.to_hex(m) == res["board"]


def _is_slow(c):
    return c["profile"] == "canonical" or c["config"].get("depth", 0) >= 3


SEARCHES = FX["searches"]
PARAMS = [pytest.param(c, marks=pytest.mark.slow) if _is_slow(c) else c for c in SEARCHES]


@pytest.mark.parametrize("case", PARAMS, ids=[f"{c['profile']}-{c['board']}" for c in SEARCHES])
def test_search(case):
    r = ExpectimaxSearch(case["config"]).search(bb.from_hex(case["board"]))
    assert (None if r.move is None else DIRECTION_LETTERS[r.move]) == case["move"]
    assert r.depth == case["depth"]
    assert [v is None for v in r.values] == [v is None for v in case["values"]]
    assert values_close(r.values, case["values"]), (r.values, case["values"])


def test_search_is_independent_of_tt_state():
    """A warm transposition table must never change a decision or a value."""
    s = ExpectimaxSearch({"depth": 2})
    cases = [c for c in SEARCHES if c["profile"] == "depth2"]
    for c in cases + cases:
        r = s.search(bb.from_hex(c["board"]))
        assert r.values == c["values"] or values_close(r.values, c["values"])
    assert s.search(bb.from_hex(cases[0]["board"])).tt_hits > 0


def test_saturating_merge():
    b = bb.from_board([15, 15] + [0] * 14)
    assert bb.to_board(bb.move(b, 2))[:2] == [15, 0]
    assert bb.from_board([17] + [0] * 15) == 15


def test_iterative_deepening():
    b = bb.from_hex(SEARCHES[0]["board"])
    r = ExpectimaxSearch({"timeBudgetMs": 50, "maxDepth": 3}).search(b)
    assert not r.deterministic
    assert r.completed_depths[0] == 1 and r.depth == r.completed_depths[-1] <= 3
    assert r.move is not None


def test_agents_return_valid_moves():
    board = board_from_hex("1024023713480379")
    obs = Observation(board, 0, 0, GameMeta(1))
    for agent in (GreedyAgent(), ExpectimaxAgent({"depth": 1})):
        d = agent.decide(obs)
        assert d.move in valid_moves(board)
    m = ExpectimaxAgent().decide(obs).metrics
    for k in ("depth", "nodes", "ttHits", "ttSize", "timeUs", "values", "heuristic"):
        assert k in m
