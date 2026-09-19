import pytest
from conftest import SPEC, load

from g2048.bench import load_suite, run_suite

EXPECTED = load("benchmarks")["suites"]

SUITES = [
    "engine-random-1k",
    pytest.param("expectimax-d2-10", marks=pytest.mark.slow),
    pytest.param("expectimax-d3-opening", marks=pytest.mark.slow),
]


@pytest.mark.parametrize("suite_id", SUITES)
def test_suite(suite_id):
    res = run_suite(load_suite(SPEC / "benchmarks" / f"{suite_id}.json"))
    exp = EXPECTED[suite_id]
    s = res["summary"]
    assert res["checksum"] == exp["checksum"]
    assert s["games"] == exp["games"]
    assert s["totalMoves"] == exp["totalMoves"]
    assert sum(g["score"] for g in res["games"]) == exp["totalScore"]
    assert s["maxScore"] == exp["maxScore"]
    _check_schema_shape(res)


def _check_schema_shape(res):
    for k in ("schemaVersion", "suiteId", "specVersion", "implementation", "environment", "agent",
              "deterministic", "startedAt", "finishedAt", "games", "summary", "checksum"):
        assert k in res
    assert res["implementation"]["language"] == "python"
    for k in ("language", "runtime", "runtimeVersion", "engineVersion", "platform"):
        assert isinstance(res["implementation"][k], str)
    for g in res["games"]:
        assert set(g) == {"seed", "score", "maxTile", "moveCount", "over", "historyHash", "wallMs", "nodes"}
    s = res["summary"]
    assert set(s["reachRates"]) == {"2048", "4096", "8192", "16384", "32768", "65536"}
    assert sum(s["tileDistribution"].values()) == s["games"]
    assert all(isinstance(v, (str, int, float)) for v in res["environment"].values())
    assert res["deterministic"] is True


def test_summary_rules():
    from g2048.bench import summarise

    games = [{"score": sc, "moveCount": 1, "nodes": 0, "maxTile": mt} for sc, mt in ((5, 2048), (1, 64), (3, 4096), (2, 64))]
    s = summarise(games, 1000.0, None, None, [4.0, 1.0, 3.0, 2.0])
    assert s["medianScore"] == 3  # sorted [1,2,3,5][floor(4/2)]
    assert s["p50DecisionUs"] == 3.0 and s["p99DecisionUs"] == 4.0
    assert list(s["tileDistribution"]) == ["64", "2048", "4096"]
    assert s["reachRates"]["2048"] == 0.5 and s["reachRates"]["4096"] == 0.25
