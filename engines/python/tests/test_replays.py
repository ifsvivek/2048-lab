import pytest
from conftest import load

from g2048.replay import ReplayError, simulate, verify

CASES = load("replays")["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_replay(case):
    exp = case["expect"]
    if exp["ok"]:
        assert simulate(case["seed"], case["moves"]).snapshot() == exp["final"]
        snap = verify({"specVersion": 1, "seed": case["seed"], "moves": case["moves"], "final": exp["final"]})
        assert snap == exp["final"]
    else:
        with pytest.raises(ReplayError) as ei:
            simulate(case["seed"], case["moves"])
        assert ei.value.code == exp["error"]
        assert ei.value.move_index == exp["moveIndex"]


def test_spec_version_and_final_mismatch():
    ok = next(c for c in CASES if c["expect"]["ok"] and c["moves"])
    with pytest.raises(ReplayError) as ei:
        verify({"specVersion": 2, "seed": ok["seed"], "moves": ok["moves"]})
    assert ei.value.code == "SPEC_VERSION"
    bad = dict(ok["expect"]["final"], score=ok["expect"]["final"]["score"] + 4)
    with pytest.raises(ReplayError) as ei:
        verify({"specVersion": 1, "seed": ok["seed"], "moves": ok["moves"], "final": bad})
    assert ei.value.code == "FINAL_MISMATCH"
