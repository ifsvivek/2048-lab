"""
LLM-backed 2048 agent (Claude).

Each decision is one Messages API call. The response is constrained with
structured outputs: the JSON schema's `move` enum is built per request from the
*currently valid* moves, so Claude cannot answer with an illegal move.

Modes
  play   pull mode — create a game on the platform and play it to the end
  serve  push mode — expose POST /decide (spec/AGENT_PROTOCOL.md) for the platform

    export ANTHROPIC_API_KEY=...        # or `ant auth login`
    uv run agent.py play --api https://g2048-api.ifsvivek.workers.dev --max-moves 200
    uv run agent.py serve --port 8080

Cost note: one API call per move; a full game is hundreds to thousands of calls.
Use --max-moves to cap a session, and --effort to trade depth for cost/latency.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anthropic

from g2048.client import PlatformClient

MODEL = "claude-opus-5"

# Stable across every call (cacheable prefix). Per-move data goes in the user turn.
SYSTEM = """You are playing 2048. Choose the single best next move.

Rules: the 4x4 board lists tile values (0 = empty), row 0 is the top. A move slides all tiles toward
that edge; equal adjacent tiles merge once per move into their sum (added to the score). After every
move a 2 (90%) or 4 (10%) appears in a random empty cell. The game ends when no move changes the board.

Strong play: keep the largest tile in one corner, keep the row/column along that corner monotonic,
preserve empty cells, prefer merges that keep the structure intact, and avoid the one direction that
would pull the largest tile out of its corner unless it is the only legal move.

Answer with the move and a one-sentence reason."""


def schema_for(valid_moves: list[str]) -> dict:
    return {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {
                "move": {"type": "string", "enum": valid_moves},
                "reason": {"type": "string"},
            },
            "required": ["move", "reason"],
            "additionalProperties": False,
        },
    }


class ClaudeAgent:
    def __init__(self, effort: str = "medium") -> None:
        self.client = anthropic.Anthropic()
        self.effort = effort
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0

    def decide(self, board: list[list[int]], score: int, move_number: int, valid_moves: list[str]) -> tuple[str, dict]:
        if len(valid_moves) == 1:  # nothing to decide — don't spend a call
            return valid_moves[0], {"timeUs": 0, "reason": "only legal move"}
        rows = "\n".join(" ".join(f"{v:>5}" for v in row) for row in board)
        prompt = f"Move {move_number}, score {score}.\nBoard:\n{rows}\n\nLegal moves: {', '.join(valid_moves)}"
        t0 = time.perf_counter()
        response = self.client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": self.effort, "format": schema_for(valid_moves)},
            # On a policy decline, the API re-runs the request on a recommended fallback model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        elapsed_us = int((time.perf_counter() - t0) * 1e6)
        self.calls += 1
        self.input_tokens += response.usage.input_tokens
        self.output_tokens += response.usage.output_tokens

        if response.stop_reason == "refusal":
            # The whole fallback chain declined; stay in the game with a legal move.
            return valid_moves[0], {"timeUs": elapsed_us, "reason": "refusal"}
        text = next((b.text for b in response.content if b.type == "text"), "")
        try:
            data = json.loads(text)
            move = data["move"] if data.get("move") in valid_moves else valid_moves[0]
            reason = str(data.get("reason", ""))[:200]
        except (json.JSONDecodeError, KeyError, TypeError):
            move, reason = valid_moves[0], "unparseable response"
        return move, {"timeUs": elapsed_us, "reason": reason}


def play(args: argparse.Namespace) -> None:
    api = PlatformClient(args.api, api_key=args.api_key)
    agent = ClaudeAgent(effort=args.effort)
    state = api.create_game(
        seed=args.seed,
        agent_name=f"claude-{args.effort}",
        config={"model": MODEL, "effort": args.effort},
        runtime={"language": "python", "runtime": "anthropic-sdk"},
    )
    print(f"game {state['gameId']}  replay {state['replayCode']}  seed {state['seed']}", flush=True)
    while state["status"] == "active" and state["moveNumber"] < args.max_moves:
        move, info = agent.decide(state["board"], state["score"], state["moveNumber"], state["validMoves"])
        state = api.move(state["gameId"], move, time_us=info["timeUs"], metrics={"timeUs": info["timeUs"]})
        print(f"  #{state['moveNumber']:4d} {move:<5} score {state['score']:6d}  {info['reason']}", flush=True)
    if state["status"] == "active":
        state = api.resign(state["gameId"])  # stop here; the replay is still recorded
    print(f"final score {state['score']}, max tile {state['maxTile']}, {state['moveNumber']} moves; "
          f"{agent.calls} API calls, {agent.input_tokens} in / {agent.output_tokens} out tokens")
    print(f"watch: /replay/{state['replayCode']}")


def serve(args: argparse.Namespace) -> None:
    agent = ClaudeAgent(effort=args.effort)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/decide":
                self.send_error(404)
                return
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            move, info = agent.decide(req["board"], req["score"], req["moveCount"], req["validMoves"])
            body = json.dumps({"move": move, "metrics": {"timeUs": info["timeUs"]}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a) -> None:  # quieter logs
            pass

    print(f"LLM agent serving POST /decide on :{args.port}", file=sys.stderr)
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("play")
    p.add_argument("--api", default="https://g2048-api.ifsvivek.workers.dev")
    p.add_argument("--api-key")
    p.add_argument("--seed", type=int)
    p.add_argument("--max-moves", type=int, default=200)
    p.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=8080)
    s.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    args = ap.parse_args()
    play(args) if args.cmd == "play" else serve(args)


if __name__ == "__main__":
    main()
