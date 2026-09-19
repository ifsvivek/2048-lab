//! Minimal HTTP/1.1 agent server (spec/AGENT_PROTOCOL.md): `POST /decide`
//! and `GET /health`, one thread per connection, `Connection: close`.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::ai::agents::{create_agent, Agent};
use crate::board::{board_from_hex, board_from_matrix, valid_moves, Board, DIRECTION_NAMES};
use crate::game::SPEC_VERSION;

const MAX_BODY_BYTES: usize = 1 << 20;
const MAX_HEADER_LINES: usize = 100;

pub struct ServerConfig {
    pub addr: String,
    pub agent_id: String,
    pub agent_config: Option<Value>,
}

struct ServerState {
    agent: Box<dyn Agent + Send>,
    last_seed: Option<u32>,
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    body: String,
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        _ => "Internal Server Error",
    }
}

fn json_response(status: u16, v: &Value) -> Response {
    Response {
        status,
        body: v.to_string(),
    }
}

fn error_response(status: u16, msg: &str) -> Response {
    json_response(status, &json!({ "error": msg }))
}

/// Start serving; blocks forever (or until the listener fails).
pub fn serve(cfg: ServerConfig) -> Result<(), String> {
    let agent = create_agent(&cfg.agent_id, cfg.agent_config.as_ref())?;
    let agent_json = json!({
        "id": agent.id(),
        "name": agent.name(),
        "version": agent.version(),
        "config": agent.config(),
    });
    let state = Arc::new(Mutex::new(ServerState {
        agent,
        last_seed: None,
    }));
    let agent_info = Arc::new(agent_json);
    let listener = TcpListener::bind(cfg.addr.as_str()).map_err(|e| format!("bind {}: {}", cfg.addr, e))?;
    eprintln!("g2048 (rust) agent server listening on http://{}", cfg.addr);
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let st = Arc::clone(&state);
                let info = Arc::clone(&agent_info);
                thread::spawn(move || {
                    handle_connection(stream, st, info);
                });
            }
            Err(e) => eprintln!("accept failed: {}", e),
        }
    }
    Ok(())
}

fn handle_connection(stream: TcpStream, state: Arc<Mutex<ServerState>>, info: Arc<Value>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let write_half = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    let response = match read_request(&mut reader) {
        Ok(req) => route(&req, &state, &info),
        Err(resp) => resp,
    };
    let _ = write_response(write_half, &response);
}

fn read_request(reader: &mut BufReader<TcpStream>) -> Result<Request, Response> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => return Err(error_response(400, "empty request")),
        Ok(_) => {}
        Err(_) => return Err(error_response(400, "unreadable request")),
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let target = parts.next().unwrap_or("/").to_string();
    let path = match target.find('?') {
        Some(q) => target[..q].to_string(),
        None => target.clone(),
    };

    let mut content_length: usize = 0;
    let mut header_lines = 0usize;
    loop {
        let mut h = String::new();
        match reader.read_line(&mut h) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => return Err(error_response(400, "unreadable headers")),
        }
        let trimmed = h.trim_end_matches(|c: char| c == '\r' || c == '\n');
        if trimmed.is_empty() {
            break;
        }
        header_lines += 1;
        if header_lines > MAX_HEADER_LINES {
            return Err(error_response(400, "too many headers"));
        }
        if let Some(colon) = trimmed.find(':') {
            let name = trimmed[..colon].trim().to_ascii_lowercase();
            let value = trimmed[colon + 1..].trim();
            if name == "content-length" {
                content_length = match value.parse::<usize>() {
                    Ok(n) => n,
                    Err(_) => return Err(error_response(400, "bad Content-Length")),
                };
            }
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err(error_response(413, "body too large"));
    }
    let mut body: Vec<u8> = vec![0u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body).is_err() {
        return Err(error_response(400, "truncated body"));
    }
    Ok(Request { method, path, body })
}

fn write_response(mut stream: TcpStream, resp: &Response) -> std::io::Result<()> {
    let body: &str = if resp.status == 204 { "" } else { resp.body.as_str() };
    let head = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: content-type, authorization\r\n\
         Access-Control-Max-Age: 86400\r\n\
         Connection: close\r\n\r\n",
        resp.status,
        reason(resp.status),
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn route(req: &Request, state: &Arc<Mutex<ServerState>>, info: &Arc<Value>) -> Response {
    if req.method == "OPTIONS" {
        return Response {
            status: 204,
            body: String::new(),
        };
    }
    match req.path.as_str() {
        "/health" | "/" => {
            if req.method != "GET" && req.method != "HEAD" {
                return error_response(405, "use GET");
            }
            let agent_v: Value = (**info).clone();
            json_response(
                200,
                &json!({
                    "ok": true,
                    "engine": "rust",
                    "engineVersion": crate::ENGINE_VERSION,
                    "specVersion": SPEC_VERSION,
                    "agent": agent_v,
                }),
            )
        }
        "/decide" => {
            if req.method != "POST" {
                return error_response(405, "use POST");
            }
            decide(&req.body, state)
        }
        _ => error_response(404, "not found"),
    }
}

fn parse_board(v: &Value) -> Result<Board, String> {
    if let Some(hex) = v.get("boardHex").and_then(|x| x.as_str()) {
        return board_from_hex(hex);
    }
    let rows = match v.get("board").and_then(|x| x.as_array()) {
        Some(r) => r,
        None => return Err(String::from("missing board / boardHex")),
    };
    let mut m: Vec<Vec<u64>> = Vec::with_capacity(4);
    for row in rows.iter() {
        let cells = match row.as_array() {
            Some(c) => c,
            None => return Err(String::from("board rows must be arrays")),
        };
        let mut r: Vec<u64> = Vec::with_capacity(4);
        for cell in cells.iter() {
            match cell.as_u64() {
                Some(x) => r.push(x),
                None => return Err(String::from("board cells must be non-negative integers")),
            }
        }
        m.push(r);
    }
    board_from_matrix(&m)
}

fn decide(body: &[u8], state: &Arc<Mutex<ServerState>>) -> Response {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return error_response(400, &format!("invalid JSON: {}", e)),
    };
    if let Some(sv) = v.get("specVersion").and_then(|x| x.as_u64()) {
        if sv != SPEC_VERSION {
            return error_response(422, &format!("unsupported specVersion {}", sv));
        }
    }
    let board = match parse_board(&v) {
        Ok(b) => b,
        Err(e) => return error_response(400, &e),
    };
    let valid = valid_moves(&board);
    if valid.is_empty() {
        return error_response(422, "no valid moves");
    }
    let seed: Option<u32> = v.get("seed").and_then(|x| x.as_u64()).map(|x| (x & 0xFFFF_FFFF) as u32);
    let move_count = v.get("moveCount").and_then(|x| x.as_u64()).unwrap_or(0);

    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(s) = seed {
        if guard.last_seed != Some(s) || move_count == 0 {
            guard.agent.reset(s);
            guard.last_seed = Some(s);
        }
    }
    let decision = guard.agent.decide(&board);
    drop(guard);

    let mv = if valid.contains(&decision.mv) { decision.mv } else { valid[0] };
    let metrics = serde_json::to_value(&decision.metrics).unwrap_or(Value::Null);
    json_response(
        200,
        &json!({
            "move": DIRECTION_NAMES[mv],
            "metrics": metrics,
        }),
    )
}
