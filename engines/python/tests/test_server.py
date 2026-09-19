import json
import threading
import urllib.request

import pytest

from g2048.server import make_server


@pytest.fixture(scope="module")
def base_url():
    httpd = make_server("127.0.0.1", 0, "expectimax", {"depth": 2})
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def _post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return r.status, dict(r.headers), json.loads(r.read())


def test_health(base_url):
    with urllib.request.urlopen(base_url + "/health") as r:
        body = json.loads(r.read())
        assert r.status == 200 and body["language"] == "python"
        assert r.headers["Access-Control-Allow-Origin"] == "*"


def test_decide_matrix_and_hex(base_url):
    req = {
        "seed": 1, "specVersion": 1, "score": 0, "moveCount": 0,
        "board": [[0, 2, 0, 0], [0, 0, 4, 0], [0, 0, 0, 0], [2, 0, 0, 0]],
        "validMoves": ["up", "down", "left", "right"],
    }
    status, headers, body = _post(base_url + "/decide", req)
    assert status == 200 and body["move"] in req["validMoves"]
    assert body["metrics"]["depth"] == 2 and body["metrics"]["nodes"] > 0
    req2 = {k: v for k, v in req.items() if k != "board"}
    req2["boardHex"] = "0100002000001000"
    assert _post(base_url + "/decide", req2)[2]["move"] == body["move"]


def test_decide_bad_request(base_url):
    with pytest.raises(urllib.error.HTTPError) as ei:
        _post(base_url + "/decide", {"board": [[3]]})
    assert ei.value.code == 400
