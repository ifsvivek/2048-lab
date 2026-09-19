"""
LLM-backed 2048 agent.

Each decision is one chat call. The reply is constrained with structured
outputs: the JSON schema's `move` enum is built per request from the
*currently valid* moves, so the model cannot answer with an illegal move.

Providers
  openrouter (default)  free model via OpenRouter — set OPENROUTER_API_KEY
                        default model: deepseek/deepseek-v4-flash-0731:free
                        (falls back to openrouter/free if unavailable)
  anthropic             Claude via the Anthropic SDK — set ANTHROPIC_API_KEY
                        (`uv sync --extra anthropic`)

Modes
  play   pull mode — create a game on the platform and play it
  serve  push mode — expose POST /decide (spec/AGENT_PROTOCOL.md)

    export OPENROUTER_API_KEY=sk-or-...
    uv run agent.py play --max-moves 200
    uv run agent.py play --model qwen/qwen3.8-27b:free
    uv run agent.py serve --port 8080

One API call per move (free OpenRouter models are rate-limited — the agent
backs off on 429). Use --max-moves to cap a session.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import os
import urllib.error
import urllib.request

from g2048.client import PlatformClient

def load_dotenv() -> None:
    """Load KEY=VALUE lines from ./.env or the repo-root .env (never overrides real env vars)."""
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(os.getcwd(), ".env"), os.path.join(here, "..", "..", ".env")):
        if not os.path.isfile(path):
            continue
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip("'\""))
        return


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_DEFAULT = "deepseek/deepseek-v4-flash-0731:free"
OPENROUTER_FALLBACK = "openrouter/free"
CLAUDE_MODEL = "claude-opus-5"

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


def board_prompt(board: list[list[int]], score: int, move_number: int, valid_moves: list[str]) -> str:
    rows = "\n".join(" ".join(f"{v:>5}" for v in row) for row in board)
    return f"Move {move_number}, score {score}.\nBoard:\n{rows}\n\nLegal moves: {', '.join(valid_moves)}"


def parse_move(text: str, valid_moves: list[str]) -> tuple[str, str]:
    try:
        data = json.loads(text)
        move = data["move"] if data.get("move") in valid_moves else valid_moves[0]
        return move, str(data.get("reason", ""))[:200]
    except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
        return valid_moves[0], "unparseable response"


class OpenRouterAgent:
    """Free models through OpenRouter's OpenAI-compatible endpoint (stdlib HTTP)."""

    def __init__(self, model: str = OPENROUTER_DEFAULT) -> None:
        self.key = os.environ.get("OPENROUTER_API_KEY")
        if not self.key:
            raise SystemExit("set OPENROUTER_API_KEY (https://openrouter.ai/keys)")
        self.model = model
        self.calls = self.input_tokens = self.output_tokens = 0

    def decide(self, board: list[list[int]], score: int, move_number: int, valid_moves: list[str]) -> tuple[str, dict]:
        if len(valid_moves) == 1:  # nothing to decide — don't spend a call
            return valid_moves[0], {"timeUs": 0, "reason": "only legal move"}
        body = {
            "model": self.model,
            "models": [self.model, OPENROUTER_FALLBACK],  # OpenRouter-side fallback routing
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": board_prompt(board, score, move_number, valid_moves)}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "move", "strict": True, "schema": schema_for(valid_moves)["schema"]}},
            # Only route to providers that honour response_format, so the enum is enforced.
            "provider": {"require_parameters": True},
            "max_tokens": 2000,
        }
        t0 = time.perf_counter()
        data = self._post(body)
        elapsed_us = int((time.perf_counter() - t0) * 1e6)
        self.calls += 1
        usage = data.get("usage") or {}
        self.input_tokens += usage.get("prompt_tokens", 0)
        self.output_tokens += usage.get("completion_tokens", 0)
        text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        move, reason = parse_move(text, valid_moves)
        return move, {"timeUs": elapsed_us, "reason": reason, "model": data.get("model", self.model)}

    def _post(self, body: dict) -> dict:
        payload = json.dumps(body).encode()
        headers = {
            "authorization": f"Bearer {self.key}",
            "content-type": "application/json",
            "http-referer": "https://g2048-web.ifsvivek.workers.dev",
            "x-title": "2048 Lab LLM agent",
        }
        for attempt in range(6):
            req = urllib.request.Request(OPENROUTER_URL, data=payload, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=120) as res:
                    return json.loads(res.read())
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:300]
                # Free models are rate-limited; upstream providers can be briefly unavailable.
                if e.code in (429, 502, 503) and attempt < 5:
                    time.sleep(min(60, 2 ** attempt * 3))
                    continue
                raise SystemExit(f"OpenRouter HTTP {e.code}: {detail}") from None
        raise SystemExit("OpenRouter: retries exhausted")


class ClaudeAgent:
    """Claude via the Anthropic SDK (optional: `uv sync --extra anthropic`)."""

    def __init__(self, effort: str = "medium") -> None:
        import anthropic  # optional dependency

        self.client = anthropic.Anthropic()
        self.effort = effort
        self.model = CLAUDE_MODEL
        self.calls = self.input_tokens = self.output_tokens = 0

    def decide(self, board: list[list[int]], score: int, move_number: int, valid_moves: list[str]) -> tuple[str, dict]:
        if len(valid_moves) == 1:
            return valid_moves[0], {"timeUs": 0, "reason": "only legal move"}
        t0 = time.perf_counter()
        response = self.client.beta.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=16000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": board_prompt(board, score, move_number, valid_moves)}],
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
            return valid_moves[0], {"timeUs": elapsed_us, "reason": "refusal"}
        text = next((b.text for b in response.content if b.type == "text"), "")
        move, reason = parse_move(text, valid_moves)
        return move, {"timeUs": elapsed_us, "reason": reason}


def make_agent(args: argparse.Namespace):
    if args.provider == "anthropic":
        return ClaudeAgent(effort=args.effort)
    return OpenRouterAgent(model=args.model)


def play(args: argparse.Namespace) -> None:
    api = PlatformClient(args.api, api_key=args.api_key)
    agent = make_agent(args)
    state = api.create_game(
        seed=args.seed,
        agent_name=f"llm:{agent.model}"[:64],
        config={"provider": args.provider, "model": agent.model},
        runtime={"language": "python", "runtime": args.provider},
    )
    print(f"game {state['gameId']}  replay {state['replayCode']}  seed {state['seed']}", flush=True)
    try:
        while state["status"] == "active" and state["moveNumber"] < args.max_moves:
            move, info = agent.decide(state["board"], state["score"], state["moveNumber"], state["validMoves"])
            state = api.move(state["gameId"], move, time_us=info["timeUs"], metrics={"timeUs": info["timeUs"]})
            print(f"  #{state['moveNumber']:4d} {move:<5} score {state['score']:6d}  {info['reason']}", flush=True)
    finally:
        # Never leave a game dangling as "live" (move cap, provider error, Ctrl-C).
        if state["status"] == "active":
            state = api.resign(state["gameId"])
    print(f"final score {state['score']}, max tile {state['maxTile']}, {state['moveNumber']} moves; "
          f"{agent.calls} API calls, {agent.input_tokens} in / {agent.output_tokens} out tokens")
    print(f"watch: /replay/{state['replayCode']}")


def serve(args: argparse.Namespace) -> None:
    agent = make_agent(args)

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
    load_dotenv()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--provider", default="openrouter", choices=["openrouter", "anthropic"])
    common.add_argument("--model", default=OPENROUTER_DEFAULT, help="OpenRouter model id (free models end in :free)")
    common.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"], help="anthropic provider only")
    p = sub.add_parser("play", parents=[common])
    p.add_argument("--api", default="https://g2048-api.ifsvivek.workers.dev")
    p.add_argument("--api-key")
    p.add_argument("--seed", type=int)
    p.add_argument("--max-moves", type=int, default=200)
    s = sub.add_parser("serve", parents=[common])
    s.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()
    play(args) if args.cmd == "play" else serve(args)


if __name__ == "__main__":
    main()
