"""HTTP agent server implementing spec/AGENT_PROTOCOL.md (``POST /decide``, ``GET /health``)."""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import ENGINE_VERSION
from .ai.agents import GameMeta, Observation, create_builtin_agent
from .board import DIRECTION_NAMES, board_from_hex, board_from_matrix, valid_moves
from .game import SPEC_VERSION

MAX_BODY = 64 * 1024
_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
}


class BadRequest(ValueError):
    pass


def parse_request_board(req: dict) -> list[int]:
    """Board from ``boardHex`` (preferred) or the ``board`` value matrix."""
    hx = req.get("boardHex")
    if isinstance(hx, str):
        try:
            return board_from_hex(hx)
        except ValueError as e:
            raise BadRequest(str(e)) from None
    m = req.get("board")
    if isinstance(m, list):
        try:
            return board_from_matrix(m)
        except (ValueError, TypeError) as e:
            raise BadRequest(str(e)) from None
    raise BadRequest("request needs 'boardHex' or 'board'")


class AgentService:
    """Thread-safe wrapper around one built-in agent.

    Expectimax keeps a single search (and transposition table) shared by all
    requests. The SPEC §10 random agent is stateful per game, so one instance
    is kept per ``gameId``/seed (LRU-bounded).
    """

    def __init__(self, agent_id: str = "expectimax", config: dict | None = None) -> None:
        self.agent_id = agent_id
        self.config = config or {}
        self._lock = threading.Lock()
        self._shared = None if agent_id == "random" else create_builtin_agent(agent_id, self.config)
        self._per_game: OrderedDict = OrderedDict()

    @property
    def descriptor(self) -> dict:
        if self._shared is not None:
            return self._shared.descriptor
        return create_builtin_agent(self.agent_id).descriptor

    def _agent_for(self, meta: GameMeta):
        if self._shared is not None:
            return self._shared
        key = meta.game_id or f"seed:{meta.seed}"
        a = self._per_game.get(key)
        if a is None:
            a = create_builtin_agent(self.agent_id, self.config)
            a.reset(meta)
            self._per_game[key] = a
            while len(self._per_game) > 1024:
                self._per_game.popitem(last=False)
        else:
            self._per_game.move_to_end(key)
        return a

    def decide(self, req: dict) -> dict:
        if not isinstance(req, dict):
            raise BadRequest("request body must be a JSON object")
        board = parse_request_board(req)
        valid = valid_moves(board)
        if not valid:
            raise BadRequest("no valid moves: the game is over")
        seed = req.get("seed", 0)
        meta = GameMeta(int(seed) if isinstance(seed, int) else 0, req.get("specVersion", SPEC_VERSION), req.get("gameId"))
        obs = Observation(board, int(req.get("score", 0) or 0), int(req.get("moveCount", 0) or 0), meta)
        with self._lock:
            d = self._agent_for(meta).decide(obs)
        move = d.move if d.move in valid else valid[0]
        metrics = {k: v for k, v in d.metrics.items() if k in ("timeUs", "nodes", "depth", "ttHits", "ttSize", "values")}
        return {"move": DIRECTION_NAMES[move], "metrics": metrics}


def make_handler(service: AgentService):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"g2048-python/{ENGINE_VERSION}"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quieter default logging
            if getattr(self.server, "verbose", False):
                super().log_message(fmt, *args)

        def _send(self, status: int, body: dict | None) -> None:
            data = b"" if body is None else json.dumps(body).encode("utf-8")
            self.send_response(status)
            for k, v in _CORS.items():
                self.send_header(k, v)
            if body is not None:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)

        def do_OPTIONS(self):
            self._send(204, None)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/health", "/"):
                self._send(
                    200,
                    {
                        "ok": True,
                        "status": "ok",
                        "language": "python",
                        "engineVersion": ENGINE_VERSION,
                        "specVersion": SPEC_VERSION,
                        "agent": service.descriptor,
                    },
                )
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            if path != "/decide":
                self._send(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self._send(413 if length > MAX_BODY else 400, {"error": "bad Content-Length"})
                return
            try:
                req = json.loads(self.rfile.read(length) or b"null")
                self._send(200, service.decide(req))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send(400, {"error": "invalid JSON"})
            except BadRequest as e:
                self._send(400, {"error": str(e)})
            except Exception as e:  # pragma: no cover - defensive
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

    return Handler


def make_server(host: str = "127.0.0.1", port: int = 8080, agent: str = "expectimax", config: dict | None = None, verbose: bool = False):
    service = AgentService(agent, config)
    httpd = ThreadingHTTPServer((host, port), make_handler(service))
    httpd.daemon_threads = True
    httpd.verbose = verbose
    return httpd


def serve(host: str = "127.0.0.1", port: int = 8080, agent: str = "expectimax", config: dict | None = None, verbose: bool = False) -> None:
    httpd = make_server(host, port, agent, config, verbose)
    print(f"g2048 python agent '{agent}' listening on http://{host}:{httpd.server_address[1]} (POST /decide, GET /health)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
