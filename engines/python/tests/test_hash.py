import pytest
from conftest import load

from g2048.board import board_from_hex
from g2048.hashing import board_hash, hash_hex, history_step

CASES = load("hash")["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["board"] for c in CASES])
def test_hash(case):
    b = board_from_hex(case["board"])
    assert hash_hex(board_hash(b)) == case["boardHash"]
    assert hash_hex(history_step(int(case["prev"], 16), b, case["dir"])) == case["historyStep"]
