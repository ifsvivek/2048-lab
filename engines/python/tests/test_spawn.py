import pytest
from conftest import load

from g2048.board import board_from_hex, board_to_hex, spawn
from g2048.rng import Rng

CASES = load("spawn")["cases"]


@pytest.mark.parametrize("case", CASES, ids=[f"{i}-{c['board']}" for i, c in enumerate(CASES)])
def test_spawn(case):
    b = board_from_hex(case["board"])
    r = Rng(case["rngState"])
    s = spawn(b, r)
    assert board_to_hex(b) == case["result"]
    assert r.state() == case["rngStateAfter"]
    exp = case["spawn"]
    assert (None if s is None else {"index": s[0], "exponent": s[1]}) == exp
