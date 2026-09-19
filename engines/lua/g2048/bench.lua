-- Benchmark-suite runner (spec/benchmarks) producing BenchmarkResult JSON
-- (spec/schemas/benchmark-result.schema.json). Field order, summary
-- definitions and number formatting follow the Go port.
--
-- Timing: pure Lua has no sub-second wall clock. Per-game `wallMs` and
-- per-decision `timeUs` use os.clock() (process CPU time, which equals wall
-- time for this single-threaded CPU-bound loop). The suite total `wallMs`
-- uses `date +%s%N` (read once at start and end) when available, falling back
-- to os.clock(); `cpuMs` is always os.clock().

local game = require("g2048.game")
local board = require("g2048.board")
local hash = require("g2048.hash")
local agents = require("g2048.agents")
local json = require("g2048.json")

local M = {}

M.REACH_TILES = { 2048, 4096, 8192, 16384, 32768, 65536 }

local clock = os.clock

--- Load a suite file. Returns suite or nil, err.
function M.load_suite(path)
  return json.read_file(path)
end

function M.has_tag(suite, tag)
  if type(suite.tags) ~= "table" then return false end
  for _, t in ipairs(suite.tags) do
    if t == tag then return true end
  end
  return false
end

--- Wall clock in nanoseconds via `date +%s%N`, or nil if unavailable.
local function wall_ns()
  local p = io.popen("date +%s%N 2>/dev/null")
  if not p then return nil end
  local s = p:read("l")
  p:close()
  local v = s and math.tointeger(tonumber(s))
  if v and v > 1e15 then return v end
  return nil
end
M.wall_ns = wall_ns

--- Play an agent on seed until the game ends or max_moves (0 = unlimited).
--- Returns {game=, nodes=, wallMs=} or nil, err.
function M.play(agent, seed, max_moves, on_decision)
  local t0 = clock()
  local g = game.new(seed)
  agent:reset(g.seed)
  local nodes = 0
  local b = g.board
  local timed = on_decision ~= nil
  local limit = (max_moves and max_moves > 0) and max_moves or math.maxinteger
  local is_over = board.is_over
  while g.move_count < limit and not is_over(b) do
    local mv, metrics = agent:decide(b, timed)
    if mv == nil or mv < 0 then
      return nil, string.format("agent %s returned no move at %d", agent.id, g.move_count)
    end
    if g:apply(mv) == nil then
      return nil, string.format("agent %s returned invalid move %d at %d", agent.id, mv, g.move_count)
    end
    if metrics.nodes then nodes = nodes + metrics.nodes end
    if on_decision then on_decision(metrics.timeUs) end
  end
  return { game = g, nodes = nodes, wallMs = math.floor((clock() - t0) * 1e6 + 0.5) / 1000 }
end

local function percentile(sorted, p)
  local n = #sorted
  if n == 0 then return 0 end
  return sorted[math.min(n - 1, math.floor(p * n)) + 1]
end

--- Summary block (definitions match the TS sim.ts / Go port).
function M.summarise(games, wall_ms, cpu_ms, peak, decisions)
  local n = #games
  local scores = {}
  local total, total_moves, nodes, max_tile = 0, 0, 0, 0
  local dist, dist_keys = {}, {}
  for i, g in ipairs(games) do
    scores[i] = g.score
    total = total + g.score
    total_moves = total_moves + g.moveCount
    nodes = nodes + g.nodes
    if g.maxTile > max_tile then max_tile = g.maxTile end
    if dist[g.maxTile] == nil then
      dist[g.maxTile] = 0
      dist_keys[#dist_keys + 1] = g.maxTile
    end
    dist[g.maxTile] = dist[g.maxTile] + 1
  end
  table.sort(scores)
  table.sort(dist_keys)
  local tile_distribution = json.obj({})
  for _, k in ipairs(dist_keys) do json.set(tile_distribution, tostring(k), dist[k]) end
  local reach = json.obj({})
  for _, t in ipairs(M.REACH_TILES) do
    local r = 0.0
    if n > 0 then
      local c = 0
      for _, g in ipairs(games) do
        if g.maxTile >= t then c = c + 1 end
      end
      r = c / n
    end
    json.set(reach, tostring(t), r)
  end
  local avg, median, min_s, max_s = 0.0, 0.0, 0, 0
  if n > 0 then
    avg = total / n
    median = scores[n // 2 + 1] + 0.0
    min_s = scores[1]
    max_s = scores[n]
  end
  local secs = wall_ms / 1000
  local gps, mps, nps = 0.0, 0.0, 0.0
  if secs > 0 then
    gps = n / secs
    mps = total_moves / secs
    nps = nodes / secs
  end
  local avg_dec, p50, p99 = json.null, json.null, json.null
  if decisions and #decisions > 0 then
    local sorted = {}
    for i, x in ipairs(decisions) do sorted[i] = x + 0.0 end
    table.sort(sorted)
    local sum = 0.0
    for _, x in ipairs(sorted) do sum = sum + x end
    avg_dec = sum / #sorted
    p50, p99 = percentile(sorted, 0.5), percentile(sorted, 0.99)
  end
  return json.obj({
    "games", n,
    "avgScore", avg,
    "medianScore", median,
    "minScore", min_s,
    "maxScore", max_s,
    "maxTile", max_tile,
    "totalMoves", total_moves,
    "wallMs", wall_ms,
    "cpuMs", cpu_ms == nil and json.null or cpu_ms,
    "gamesPerSec", gps,
    "movesPerSec", mps,
    "decisionsPerSec", mps,
    "nodes", nodes,
    "nodesPerSec", nps,
    "peakMemoryBytes", peak == nil and json.null or peak,
    "avgDecisionUs", avg_dec,
    "p50DecisionUs", p50,
    "p99DecisionUs", p99,
    "tileDistribution", tile_distribution,
    "reachRates", reach,
  })
end

--- fnv1a32 over the concatenated historyHash strings.
function M.checksum(games)
  local parts = {}
  for i, g in ipairs(games) do parts[i] = g.historyHash end
  return hash.hex(hash.fnv1a32(table.concat(parts)))
end

local function read_file(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local s = f:read("a")
  f:close()
  return s
end

local function command_output(cmd)
  local p = io.popen(cmd .. " 2>/dev/null")
  if not p then return nil end
  local s = p:read("a")
  p:close()
  if s then s = s:match("^%s*(.-)%s*$") end
  if s == "" then return nil end
  return s
end

--- Operating-system name in Go's runtime.GOOS style.
local function os_name()
  if package.config:sub(1, 1) == "\\" then return "windows" end
  if read_file("/proc/version") then return "linux" end
  local u = command_output("uname -s")
  if u then
    u = u:lower()
    if u == "darwin" then return "darwin" end
    return u
  end
  return "unknown"
end

local ARCH = { x86_64 = "amd64", amd64 = "amd64", aarch64 = "arm64", arm64 = "arm64", i686 = "386", i386 = "386" }

--- Peak resident set size (VmHWM) in bytes, or nil where /proc is unavailable.
function M.peak_memory()
  local s = read_file("/proc/self/status")
  if not s then return nil end
  local kb = s:match("VmHWM:%s*(%d+)%s*kB")
  if not kb then return nil end
  return math.tointeger(tonumber(kb)) * 1024
end

--- Runtime version: the launcher exports G2048_LUA_VERSION (e.g. "5.5.1").
local function runtime_version()
  local v = os.getenv("G2048_LUA_VERSION")
  if v and v:match("^%d+%.%d+") then return v end
  return (_VERSION:gsub("^Lua%s*", ""))
end

function M.implementation()
  return json.obj({
    "language", "lua",
    "runtime", "lua",
    "runtimeVersion", runtime_version(),
    "engineVersion", game.ENGINE_VERSION,
    "platform", os_name(),
  })
end

--- Host facts (keys sorted like Go's map encoding).
function M.environment()
  local env = {}
  local osn = os_name()
  env.os = osn
  local m = command_output("uname -m")
  env.arch = m and (ARCH[m] or m) or "unknown"
  local cpuinfo = read_file("/proc/cpuinfo")
  local cpus = 0
  if cpuinfo then
    for line in cpuinfo:gmatch("[^\n]+") do
      local k, v = line:match("^([^:]-)%s*:%s*(.*)$")
      if k == "processor" then cpus = cpus + 1 end
      if k == "model name" and env.cpu == nil then env.cpu = v end
    end
  end
  if cpus == 0 then cpus = math.tointeger(tonumber(command_output("getconf _NPROCESSORS_ONLN") or "")) or 1 end
  env.cpus = cpus
  local meminfo = read_file("/proc/meminfo")
  if meminfo then
    local kb = meminfo:match("MemTotal:%s*(%d+)%s*kB")
    if kb then env.memoryBytes = math.tointeger(tonumber(kb)) * 1024 end
  end
  return env -- no recorded order: encoded with sorted keys
end

local function iso_from_ns(ns)
  if ns then
    local secs = ns // 1000000000
    local ms = (ns // 1000000) % 1000
    return os.date("!%Y-%m-%dT%H:%M:%S", secs) .. string.format(".%03dZ", ms)
  end
  return os.date("!%Y-%m-%dT%H:%M:%S") .. ".000Z"
end

--- Run a suite. `progress` is a file handle (or nil). Returns result or nil, err.
function M.run(suite, progress)
  if suite.specVersion ~= game.SPEC_VERSION then
    return nil, string.format("suite %s targets spec v%s", tostring(suite.id), tostring(suite.specVersion))
  end
  local agent_spec = suite.agent or {}
  local cfg = agent_spec.config
  if cfg == json.null then cfg = nil end
  local agent, err = agents.new(agent_spec.id, cfg)
  if not agent then return nil, err end

  local w0 = wall_ns()
  local started_at = iso_from_ns(w0)
  local c0 = clock()
  local decisions, on_decision
  if suite.timeDecisions == true then
    decisions = {}
    local nd = 0
    on_decision = function(us)
      nd = nd + 1
      decisions[nd] = us
    end
  end
  local seeds = suite.seeds or {}
  local start, count = seeds.start or 0, seeds.count or 0
  local max_moves = suite.maxMoves or 0
  local games = {}
  for i = 0, count - 1 do
    local seed = (start + i) & 0xffffffff
    local pr, perr = M.play(agent, seed, max_moves, on_decision)
    if not pr then return nil, perr end
    local g = pr.game
    local r = {
      seed = seed,
      score = g.score,
      maxTile = 1 << board.max_exponent(g.board),
      moveCount = g.move_count,
      over = g:over(),
      historyHash = g:history_hash(),
      wallMs = pr.wallMs,
      nodes = pr.nodes,
    }
    games[#games + 1] = r
    if progress and (count <= 100 or (i + 1) % 100 == 0 or i + 1 == count) then
      progress:write(string.format("[%s] game %d/%d seed=%d score=%d maxTile=%d moves=%d %.0fms\n",
        suite.id, i + 1, count, seed, r.score, r.maxTile, r.moveCount, r.wallMs))
      progress:flush()
    end
  end
  local cpu_ms = (clock() - c0) * 1000
  local w1 = wall_ns()
  local wall_ms = cpu_ms
  if w0 and w1 then wall_ms = (w1 - w0) / 1e6 end

  local games_json = json.array({})
  for i, r in ipairs(games) do
    games_json[i] = json.obj({
      "seed", r.seed, "score", r.score, "maxTile", r.maxTile, "moveCount", r.moveCount, "over", r.over,
      "historyHash", r.historyHash, "wallMs", r.wallMs + 0.0, "nodes", r.nodes,
    })
  end
  local agent_ref = json.obj({ "id", agent_spec.id, "config", cfg })
  return json.obj({
    "schemaVersion", 1,
    "suiteId", suite.id,
    "specVersion", game.SPEC_VERSION,
    "implementation", M.implementation(),
    "environment", M.environment(),
    "agent", agent_ref,
    "deterministic", agent:deterministic(),
    "startedAt", started_at,
    "finishedAt", iso_from_ns(w1),
    "games", games_json,
    "summary", M.summarise(games, wall_ms + 0.0, cpu_ms + 0.0, M.peak_memory(), decisions),
    "checksum", M.checksum(games),
  }), games
end

return M
