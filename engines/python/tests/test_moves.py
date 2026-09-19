import pytest
from conftest import load

from g2048.board import DIRECTION_LETTERS, board_from_hex, board_to_hex, can_move, is_over, move, valid_moves

CASES = load("moves")["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["board"] for c in CASES])
def test_move(case):
    b = board_from_hex(case["board"])
    for res in case["results"]:
        d = DIRECTION_LETTERS.index(res["dir"])
        nb, gained, changed = move(b, d)
        assert (board_to_hex(nb), gained, changed) == (res["board"], res["gained"], res["changed"]), res["dir"]
        assert can_move(b, d) == res["changed"]
    assert board_to_hex(b) == case["board"], "move() must not mutate its input"
    if "over" in case:
        assert is_over(b) == case["over"]
        assert (valid_moves(b) == []) == case["over"]


def test_merge_rules():
    # SPEC §3 examples, as a left move on row 0
    for line, want in (([1, 1, 1, 1], [2, 2, 0, 0]), ([1, 1, 2, 0], [2, 2, 0, 0]), ([2, 1, 1, 0], [2, 2, 0, 0])):
        nb, gained, changed = move(line + [0] * 12, 2)
        assert nb[:4] == want and changed
