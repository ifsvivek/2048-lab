"""
External Python agent playing through the public API (pull mode).

The decision logic is the Python port's canonical expectimax — it runs on your
machine; the platform only validates and records moves. Run from the repo:

    cd engines/python
    uv run python ../../agents/python-api-agent/play.py --api https://2048api.ifsvivek.in --depth 2
"""

import argparse
import time

from g2048.ai.agents import ExpectimaxAgent, GameMeta, Observation
from g2048.board import board_from_hex
from g2048.client import PlatformClient

DIRS = ["up", "down", "left", "right"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="https://2048api.ifsvivek.in")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--depth", type=int, default=2)
    ap.add_argument("--api-key", help="attribute games to a registered agent")
    args = ap.parse_args()

    api = PlatformClient(args.api, api_key=args.api_key)
    state = api.create_game(seed=args.seed, agent_name=f"python-expectimax-d{args.depth}", config={"depth": args.depth}, runtime={"language": "python", "runtime": "cpython"})
    print(f"game {state['gameId']}  replay {state['replayCode']}  seed {state['seed']}")
    agent = ExpectimaxAgent({"depth": args.depth})
    meta = GameMeta(state["seed"], game_id=state["gameId"])
    while state["status"] == "active":
        t0 = time.perf_counter()
        decision = agent.decide(Observation(board_from_hex(state["boardHex"]), state["score"], state["moveNumber"], meta))
        us = int((time.perf_counter() - t0) * 1e6)
        state = api.move(state["gameId"], DIRS[decision.move], time_us=us, metrics={"depth": args.depth, "nodes": decision.metrics.get("nodes", 0), "timeUs": us})
        if state["moveNumber"] % 100 == 0:
            print(f"  move {state['moveNumber']:5d}  score {state['score']:7d}  max {state['maxTile']}")
    print(f"final score {state['score']}, max tile {state['maxTile']}, {state['moveNumber']} moves — watch: /replay/{state['replayCode']}")


if __name__ == "__main__":
    main()
