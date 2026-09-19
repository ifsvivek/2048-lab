import pytest
from conftest import load

from g2048.rng import Rng, mix32

CASES = load("rng")["cases"]


@pytest.mark.parametrize("case", CASES, ids=[str(c["seed"]) for c in CASES])
def test_mix32_and_next(case):
    assert mix32(case["seed"]) == case["state"]
    r = Rng.from_seed(case["seed"])
    assert [r.next() for _ in case["next"]] == case["next"]


@pytest.mark.parametrize("case", CASES, ids=[str(c["seed"]) for c in CASES])
def test_below(case):
    for n, seq in case["below"].items():
        r = Rng.from_seed(case["seed"])
        assert [r.below(int(n)) for _ in seq] == seq, f"below({n})"


def test_all_zero_state_guard():
    # mix32 never yields all zeros in practice, but the guard must not break anything.
    assert mix32(0) != [0, 0, 0, 0]
