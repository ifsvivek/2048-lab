import pytest
from conftest import load

from g2048.ids import (
    REPLAY_ALPHABET,
    format_replay_code,
    generate_replay_code,
    is_ulid,
    normalize_replay_code,
    random_seed,
    ulid,
)

FX = load("codes")


def test_alphabet():
    assert FX["alphabet"] == REPLAY_ALPHABET


@pytest.mark.parametrize("case", FX["cases"], ids=[repr(c["input"]) for c in FX["cases"]])
def test_code(case):
    n = normalize_replay_code(case["input"])
    assert n == case["normalized"]
    assert (format_replay_code(n) if n is not None else None) == case["formatted"]


def test_generated_ids():
    code = generate_replay_code()
    assert normalize_replay_code(code) == code.replace("-", "")
    assert format_replay_code(code.replace("-", "")) == code
    u = ulid()
    assert len(u) == 26 and is_ulid(u)
    assert ulid(0).startswith("0000000000")
    assert 0 <= random_seed() < 2**32
