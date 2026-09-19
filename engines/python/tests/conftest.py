import json
from pathlib import Path

import pytest

from g2048.validate import default_fixtures_dir

FIXTURES = default_fixtures_dir()
SPEC = FIXTURES.parent


def load(name: str) -> dict:
    with open(FIXTURES / f"{name}.json", encoding="utf-8") as f:
        return json.load(f)


def ids(cases, key):
    return [str(c[key]) for c in cases]


@pytest.fixture(scope="session")
def spec_dir() -> Path:
    return SPEC
