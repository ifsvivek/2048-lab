-- Fixture checks against spec/fixtures (mirrors engines/go/internal/validate).

local rngmod = require("g2048.rng")
local board = require("g2048.board")
local hash = require("g2048.hash")
local game = require("g2048.game")
local replay = require("g2048.replay")
local ids = require("g2048.ids")
local bitboard = require("g2048.bitboard")
local heuristic = require("g2048.heuristic")
local expectimax = require("g2048.expectimax")
local agents = require("g2048.agents")
local bench = require("g2048.bench")
local json = require("g2048.json")

local M = {}

M.FIXTURES = { "rng.json", "moves.json", "spawn.json", "hash.json", "games.json", "replays.json", "codes.json",
  "ai.json", "benchmarks.json" }

local fmt = string.format
local null = json.null

local Report = {}
Report.__index = Report

function M.new_report()
  return setmetatable({ passed = 0, failed = 0, failures = {}, per_fixture = {} }, Report)
end

function Report:check(fixture, name, ok, message, ...)
  local pf = self.per_fixture[fixture]
  if not pf then
    pf = { 0, 0 }
    self.per_fixture[fixture] = pf
  end
  if ok then
    self.passed = self.passed + 1
    pf[1] = pf[1] + 1
  else
    self.failed = self.failed + 1
    pf[2] = pf[2] + 1
    if select("#", ...) > 0 then message = fmt(message, ...) end
    self.failures[#self.failures + 1] = { fixture = fixture, case = name, message = tostring(message) }
  end
  return ok
end

function Report:fail(fixture, name, message, ...)
  self:check(fixture, name, false, message, ...)
end

--- Report as an ordered JSON object (Go report shape + engineVersion).
function Report:to_json()
  local failures = json.array({})
  for i, f in ipairs(self.failures) do
    failures[i] = json.obj({ "fixture", f.fixture, "case", f.case, "message", f.message })
  end
  return json.obj({
    "language", "lua",
    "engineVersion", game.ENGINE_VERSION,
    "passed", self.passed,
    "failed", self.failed,
    "failures", failures,
  })
end

local function load(dir, name)
  local v, err = json.read_file(dir .. "/" .. name)
  if v == nil then error(err, 0) end
  return v
end

local function state_eq(a, b)
  if type(b) ~= "table" then return false end
  for i = 1, 4 do
    if a[i] ~= b[i] then return false end
  end
  return true
end

local function state_str(s)
  return fmt("[%d %d %d %d]", s[1], s[2], s[3], s[4])
end

local function bool(v) return v and "true" or "false" end

---------------------------------------------------------------------------

local function check_rng(r, dir)
  local fx = load(dir, "rng.json")
  local F = "rng.json"
  for _, c in ipairs(fx.cases) do
    local id = fmt("seed=%d", c.seed)
    local st = rngmod.mix32(c.seed)
    r:check(F, id .. " state", state_eq(st, c.state), "state %s, want %s", state_str(st), state_str(c.state))
    local g = rngmod.new(st)
    local ok = true
    for i, want in ipairs(c.next) do
      local got = g:next()
      if got ~= want then
        r:fail(F, id .. " next", "next[%d]=%d, want %d", i - 1, got, want)
        ok = false
        break
      end
    end
    if ok then r:check(F, id .. " next", true, "") end
    local keys = json.keys(c.below) or {}
    for _, ns in ipairs(keys) do
      local seq = c.below[ns]
      local n = math.tointeger(tonumber(ns))
      local gb = rngmod.from_seed(c.seed)
      local good = true
      for i, want in ipairs(seq) do
        local got = gb:below(n)
        if got ~= want then
          r:fail(F, id .. " below(" .. ns .. ")", "below[%d]=%d, want %d", i - 1, got, want)
          good = false
          break
        end
      end
      if good then r:check(F, id .. " below(" .. ns .. ")", true, "") end
    end
  end
end

local function check_moves(r, dir)
  local fx = load(dir, "moves.json")
  local F = "moves.json"
  for _, c in ipairs(fx.cases) do
    local b, err = board.from_hex(c.board)
    if not b then
      r:fail(F, c.board, "%s", err)
    else
      for _, res in ipairs(c.results) do
        local d = board.parse_direction(res.dir)
        local nb, g, ch = board.move(b, d)
        local cm = board.can_move(b, d)
        local id = c.board .. " " .. res.dir
        local hex = board.to_hex(nb)
        r:check(F, id, hex == res.board and g == res.gained and ch == res.changed and cm == res.changed,
          "got board=%s gained=%d changed=%s canMove=%s, want %s %d %s", hex, g, bool(ch), bool(cm),
          res.board, res.gained, bool(res.changed))
      end
      local over = board.is_over(b)
      r:check(F, c.board .. " over", over == c.over, "over=%s, want %s", bool(over), bool(c.over))
    end
  end
end

local function check_spawn(r, dir)
  local fx = load(dir, "spawn.json")
  local F = "spawn.json"
  for i, c in ipairs(fx.cases) do
    local b = board.must(c.board)
    local g = rngmod.new(c.rngState)
    local idx, e = board.spawn(b, g)
    local ok = idx ~= nil
    local want_spawn = c.spawn ~= nil and c.spawn ~= null
    local good = board.to_hex(b) == c.result and state_eq(g:state(), c.rngStateAfter) and ok == want_spawn
    if good and ok then good = idx == c.spawn.index and e == c.spawn.exponent end
    r:check(F, fmt("#%d %s", i - 1, c.board), good, "got %s idx=%s exp=%s ok=%s state=%s", board.to_hex(b),
      tostring(idx), tostring(e), bool(ok), state_str(g:state()))
  end
end

local function check_hash(r, dir)
  local fx = load(dir, "hash.json")
  local F = "hash.json"
  for _, c in ipairs(fx.cases) do
    local b = board.must(c.board)
    local bh = hash.hex(hash.board_hash(b))
    local prev = tonumber(c.prev, 16)
    if prev == nil then error("bad prev hash " .. tostring(c.prev), 0) end
    local hs = hash.hex(hash.history_step(prev, b, c.dir))
    r:check(F, c.board, bh == c.boardHash and hs == c.historyStep, "boardHash=%s historyStep=%s, want %s %s",
      bh, hs, c.boardHash, c.historyStep)
  end
end

local function same_final(s, f)
  return s.board == f.board and s.score == f.score and s.moveCount == f.moveCount and s.maxTile == f.maxTile
    and s.over == f.over and s.historyHash == f.historyHash
end

local function final_str(s)
  return fmt("{board:%s score:%d moveCount:%d maxTile:%d over:%s historyHash:%s}", s.board, s.score,
    s.moveCount, s.maxTile, bool(s.over), s.historyHash)
end

local function check_games(r, dir)
  local fx = load(dir, "games.json")
  local F = "games.json"
  for _, c in ipairs(fx.newGames) do
    local g = game.new(c.seed)
    local hex, st, hh = board.to_hex(g.board), g.rng:state(), g:history_hash()
    r:check(F, fmt("newGame seed=%d", c.seed), hex == c.board and state_eq(st, c.rngState) and hh == c.historyHash,
      "board=%s rng=%s hash=%s", hex, state_str(st), hh)
  end
  for _, c in ipairs(fx.games) do
    local id = fmt("game seed=%d agent=%s", c.seed, c.agent)
    local g, err = replay.simulate(c.seed, c.moves)
    if not g then
      r:fail(F, id .. " replay", "%s", tostring(err))
    else
      local s = g:snapshot()
      r:check(F, id .. " replay", same_final(s, c.final), "final %s, want %s", final_str(s), final_str(c.final))
    end
    local agent
    if c.agent == "random" then
      agent = agents.random()
    elseif c.agent == "expectimax-d2" then
      agent = agents.new("expectimax", { depth = 2 })
    end
    if agent then
      -- Random games run to completion; expectimax-d2 games were generated
      -- with maxMoves=1500, so cap at the recorded length when not over.
      local limit = 0
      if not c.final.over then limit = #c.moves end
      local pr, perr = bench.play(agent, c.seed, limit, nil)
      if not pr then
        r:fail(F, id .. " agent", "%s", perr)
      else
        local moves = pr.game:moves_string()
        r:check(F, id .. " agent", moves == c.moves and same_final(pr.game:snapshot(), c.final),
          "agent replay diverged (moves %d vs %d)", #moves, #c.moves)
      end
    end
  end
end

local function check_replays(r, dir)
  local fx = load(dir, "replays.json")
  local F = "replays.json"
  for _, c in ipairs(fx.cases) do
    local snap, err = replay.verify(1, c.seed, c.moves, nil)
    local ex = c.expect
    if ex.ok then
      local ok = err == nil and snap ~= nil and same_final(snap, ex.final)
      r:check(F, c.name, ok, "err=%s final=%s", tostring(err), snap and final_str(snap) or "nil")
      if ok then
        local f = ex.final
        local _, e1 = replay.verify(1, c.seed, c.moves,
          { board = f.board, score = f.score, moveCount = f.moveCount, historyHash = f.historyHash })
        r:check(F, c.name .. " claim", e1 == nil, "valid claim rejected: %s", tostring(e1))
        local _, e2 = replay.verify(1, c.seed, c.moves, { score = f.score + 4 })
        r:check(F, c.name .. " bad-claim", e2 ~= nil and e2.code == replay.FINAL_MISMATCH,
          "want FINAL_MISMATCH, got %s", tostring(e2))
        local _, e3 = replay.verify(2, c.seed, c.moves, nil)
        r:check(F, c.name .. " spec-version", e3 ~= nil and e3.code == replay.SPEC_VERSION,
          "want SPEC_VERSION, got %s", tostring(e3))
      end
    else
      local ok = err ~= nil and replay.is_replay_error(err) and err.code == ex.error
      if ok and ex.moveIndex ~= nil and ex.moveIndex ~= null then ok = err.moveIndex == ex.moveIndex end
      r:check(F, c.name, ok, "got %s, want %s at %s", tostring(err), tostring(ex.error), tostring(ex.moveIndex))
    end
  end
end

local function check_codes(r, dir)
  local fx = load(dir, "codes.json")
  local F = "codes.json"
  r:check(F, "alphabet", fx.alphabet == ids.REPLAY_ALPHABET, "alphabet mismatch")
  for _, c in ipairs(fx.cases) do
    local n = ids.normalize_replay_code(c.input)
    local good
    if c.normalized == nil or c.normalized == null then
      good = n == nil
    else
      good = n ~= nil and n == c.normalized and type(c.formatted) == "string"
        and ids.format_replay_code(n) == c.formatted
    end
    r:check(F, c.input, good, "normalized=%q ok=%s", n or "", bool(n ~= nil))
  end
end

local function rel_close(a, b)
  if a == b then return true end
  return math.abs(a - b) <= 1e-9 * math.max(math.abs(a), math.abs(b))
end

local function features_eq(a, b)
  for _, k in ipairs(heuristic.FEATURE_KEYS) do
    if a[k] ~= b[k] then return false end
  end
  return true
end

local function features_str(f)
  return fmt("{empty:%d merges:%d mono:%d sum:%d smooth:%d stable:%d}", f.empty, f.merges, f.mono, f.sum,
    f.smooth, f.stable)
end

local function num(v) return json.format_float(v + 0.0) end

-- informational: search values that were bit-identical
M.ai_exact, M.ai_total = 0, 0

local function check_ai(r, dir)
  local fx = load(dir, "ai.json")
  local F = "ai.json"
  local wc, wa = fx.weights.canonical, fx.weights.allWeights
  r:check(F, "canonical weights", heuristic.weights_equal(wc, heuristic.heuristic_v1()), "canonical weights mismatch")
  local tc, ta = heuristic.line_table(wc), heuristic.line_table(wa)
  for _, l in ipairs(fx.lines) do
    local f = heuristic.features(l.line)
    local vc, va = tc[l.line] + 0.0, ta[l.line] + 0.0
    r:check(F, fmt("line %d", l.line), features_eq(f, l.features) and vc == l.canonical and va == l.allWeights,
      "features %s canonical=%s allWeights=%s, want %s %s %s", features_str(f), num(vc), num(va),
      features_str(l.features), num(l.canonical), num(l.allWeights))
  end
  for _, e in ipairs(fx.evaluations) do
    local bb = bitboard.from_board(board.must(e.board))
    local vc = heuristic.evaluate(bb, tc, wc.corner or 0)
    local va = heuristic.evaluate(bb, ta, wa.corner or 0)
    r:check(F, "eval " .. e.board, vc == e.canonical and va == e.allWeights, "canonical=%s allWeights=%s, want %s %s",
      num(vc), num(va), num(e.canonical), num(e.allWeights))
  end
  for _, m in ipairs(fx.bitboardMoves) do
    local bb = bitboard.from_board(board.must(m.board))
    for i, res in ipairs(m.results) do
      local d = i - 1
      local nb, ch = bitboard.move(bb, d)
      local out = board.to_hex(bitboard.to_board(nb))
      r:check(F, fmt("bbmove %s %s", m.board, board.LETTERS:sub(d + 1, d + 1)), out == res.board and ch == res.changed,
        "got %s %s, want %s %s", out, bool(ch), res.board, bool(res.changed))
    end
  end
  local searchers = {}
  for _, s in ipairs(fx.searches) do
    local id = fmt("search %s %s", s.profile, s.board)
    local key = json.encode(s.config)
    local srch = searchers[key]
    local skip = false
    if not srch then
      local c, err = expectimax.parse_config(s.config)
      if not c then
        r:fail(F, id, "config: %s", err)
        skip = true
      else
        c.ttBits = 18
        srch = expectimax.new_search(c)
        searchers[key] = srch
      end
    end
    if not skip then
      local res = srch.run(bitboard.from_board(board.must(s.board)))
      local move = res.move >= 0 and board.LETTERS:sub(res.move + 1, res.move + 1) or "null"
      local want = (s.move == nil or s.move == null) and "null" or s.move
      local ok = move == want and res.depth == s.depth and #s.values == 4
      local msg = fmt("move=%s depth=%d, want %s %d", move, res.depth, want, s.depth)
      for d = 0, 3 do
        if not ok then break end
        local got, exp = res.values[d], s.values[d + 1]
        if (got == null) ~= (exp == null) then
          ok = false
          msg = fmt("values[%d] null mismatch", d)
        elseif got ~= null then
          M.ai_total = M.ai_total + 1
          if got == exp then M.ai_exact = M.ai_exact + 1 end
          if not rel_close(got, exp) then
            ok = false
            msg = fmt("values[%d]=%s, want %s", d, num(got), num(exp))
          end
        end
      end
      r:check(F, id, ok, "%s", msg)
    end
  end
end

local function check_benchmarks(r, dir, opts, name)
  local fx = load(dir, name)
  local ids_ = json.keys(fx.suites) or {}
  local sorted = {}
  for i, k in ipairs(ids_) do sorted[i] = k end
  table.sort(sorted)
  for _, id in ipairs(sorted) do
    local want = fx.suites[id]
    local suite, err = bench.load_suite(dir .. "/../benchmarks/" .. id .. ".json")
    if not suite then
      r:fail(name, id, "%s", tostring(err))
    elseif bench.has_tag(suite, "heavy") and not opts.heavy then
      -- heavy suites are skipped unless explicitly requested
    else
      if opts.progress then
        opts.progress:write(fmt("[validate] running benchmark suite %s ...\n", id))
        opts.progress:flush()
      end
      local res, games = bench.run(suite, nil)
      if not res then
        r:fail(name, id, "%s", tostring(games))
      else
        local total = 0
        for _, g in ipairs(games) do total = total + g.score end
        local s = res.summary
        r:check(name, id, res.checksum == want.checksum and s.games == want.games and s.totalMoves == want.totalMoves
          and total == want.totalScore and s.maxScore == want.maxScore,
          "checksum=%s games=%d totalMoves=%d totalScore=%d maxScore=%d, want %s", res.checksum, s.games,
          s.totalMoves, total, s.maxScore, json.encode(want))
      end
    end
  end
end

local CHECKS = {
  ["rng.json"] = check_rng,
  ["moves.json"] = check_moves,
  ["spawn.json"] = check_spawn,
  ["hash.json"] = check_hash,
  ["games.json"] = check_games,
  ["replays.json"] = check_replays,
  ["codes.json"] = check_codes,
  ["ai.json"] = check_ai,
}

--- Check a single fixture file.
function M.run(r, dir, name, opts)
  opts = opts or {}
  local ok, err = pcall(function()
    if name == "benchmarks.json" or name == "benchmarks-heavy.json" then
      check_benchmarks(r, dir, opts, name)
    else
      local f = CHECKS[name]
      if not f then error("unknown fixture", 0) end
      f(r, dir)
    end
  end)
  if not ok then r:fail(name, "load", "%s", tostring(err)) end
end

--- Run every fixture check. opts: skip_bench, heavy, progress.
function M.all(dir, opts)
  opts = opts or {}
  local r = M.new_report()
  for _, f in ipairs(M.FIXTURES) do
    if not (f == "benchmarks.json" and opts.skip_bench) then M.run(r, dir, f, opts) end
  end
  if opts.heavy and not opts.skip_bench then M.run(r, dir, "benchmarks-heavy.json", opts) end
  return r
end

return M
