import pytest
from conftest import load

from g2048.board import board_to_hex
from g2048.game import Game
from g2048.replay import simulate
from g2048.validate import play_random

FX = load("games")


@pytest.mark.parametrize("case", FX["newGames"], ids=[str(c["seed"]) for c in FX["newGames"]])
def test_new_game(case):
    g = Game(case["seed"])
    assert board_to_hex(g.board) == case["board"]
    assert g.rng_state() == case["rngState"]
    assert g.history_hash == case["historyHash"]
    assert g.score == 0 and g.move_count == 0


@pytest.mark.parametrize("case", FX["games"], ids=[f"{c['agent']}-{c['seed']}" for c in FX["games"]])
def test_game_replay(case):
    g = simulate(case["seed"], case["moves"])
    assert g.snapshot() == case["final"]
    assert g.moves == case["moves"]


RANDOM = [c for c in FX["games"] if c["agent"] == "random"]


@pytest.mark.parametrize("case", RANDOM, ids=[str(c["seed"]) for c in RANDOM])
def test_random_agent_reproduces_moves(case):
    g = play_random(case["seed"])
    assert g.moves == case["moves"]
    assert g.snapshot() == case["final"]


def test_invalid_move_changes_nothing():
    g = simulate(106, "URUDDURLDLDDUDLRDLLRRRRLURUURD")  # replays.json: the next 'D' is invalid
    before = (list(g.board), g.score, g.move_count, g.history_hash, g.rng_state(), g.moves)
    assert g.apply(1) is None
    assert (list(g.board), g.score, g.move_count, g.history_hash, g.rng_state(), g.moves) == before
