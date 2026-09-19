-- g2048 — Lua port CLI: validate, bench, play.
-- Run through bin/g2048, which sets LUA_PATH and picks a Lua >= 5.4.

if not math.type or math.type(1) ~= "integer" or (1 << 62) == 0 then
  io.stderr:write("error: g2048 needs Lua >= 5.4 (64-bit integers); running " .. _VERSION .. "\n")
  os.exit(2)
end

-- make `require("g2048.x")` work when started directly as `lua main.lua`
local script_dir = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = script_dir .. "/?.lua;" .. package.path

local game = require("g2048.game")
local ids = require("g2048.ids")
local agents = require("g2048.agents")
local bench = require("g2048.bench")
local validate = require("g2048.validate")
local json = require("g2048.json")

local USAGE = [[
usage: g2048 <command> [flags]

commands:
  validate [--fixtures DIR] [--json] [--skip-bench] [--heavy]   run every spec fixture check
  bench --suite FILE [--out FILE]                                run a benchmark suite, emit BenchmarkResult JSON
  play --seed N [--agent expectimax|random|greedy] [--depth auto|N] [--max-moves N]
]]

local function die(msg)
  io.stderr:write("error: " .. msg .. "\n")
  os.exit(1)
end

--- Parse Go-style flags: --name value, --name=value, -name value; booleans in `bools`.
local function parse_flags(args, spec)
  local out = {}
  local i = 1
  while i <= #args do
    local a = args[i]
    local name, val = a:match("^%-%-?([^=]+)=(.*)$")
    if not name then name = a:match("^%-%-?(.+)$") end
    if not name then
      io.stderr:write(string.format("unexpected argument %q\n\n%s", a, USAGE))
      os.exit(2)
    end
    local kind = spec[name]
    if kind == nil then
      io.stderr:write(string.format("flag provided but not defined: -%s\n\n%s", name, USAGE))
      os.exit(2)
    end
    if kind == "bool" then
      if val == nil then
        out[name] = true
      else
        out[name] = (val == "true" or val == "1")
      end
    else
      if val == nil then
        i = i + 1
        val = args[i]
        if val == nil then
          io.stderr:write(string.format("flag needs an argument: -%s\n\n%s", name, USAGE))
          os.exit(2)
        end
      end
      out[name] = val
    end
    i = i + 1
  end
  return out
end

local function is_dir(path)
  local f = io.open(path .. "/rng.json", "r")
  if f then
    f:close()
    return true
  end
  return false
end

local function default_fixtures()
  local env = os.getenv("G2048_FIXTURES")
  if env and env ~= "" then return env end
  for _, c in ipairs({ script_dir .. "/../../spec/fixtures", "../../spec/fixtures", "spec/fixtures",
    "../spec/fixtures", "../../../spec/fixtures" }) do
    if is_dir(c) then return c end
  end
  return "../../spec/fixtures"
end

local function cmd_validate(args)
  local fl = parse_flags(args, { fixtures = "string", json = "bool", ["skip-bench"] = "bool", heavy = "bool" })
  local dir = fl.fixtures or default_fixtures()
  local r = validate.all(dir, {
    skip_bench = fl["skip-bench"],
    heavy = fl.heavy,
    progress = (not fl.json) and io.stderr or nil,
  })
  if fl.json then
    print(json.encode(r:to_json()))
  else
    print(string.format("lua engine %s (%s) — fixtures: %s", game.ENGINE_VERSION, _VERSION, dir))
    local files = {}
    for _, f in ipairs(validate.FIXTURES) do files[#files + 1] = f end
    files[#files + 1] = "benchmarks-heavy.json"
    for _, f in ipairs(files) do
      local pf = r.per_fixture[f]
      if pf then
        print(string.format("  %-16s %4d passed %4d failed  %s", f, pf[1], pf[2], pf[2] > 0 and "FAIL" or "ok"))
      end
    end
    for _, f in ipairs(r.failures) do
      print(string.format("  FAIL %s [%s]: %s", f.fixture, f.case, f.message))
    end
    print(string.format("%d passed, %d failed", r.passed, r.failed))
  end
  if r.failed > 0 then os.exit(1) end
end

local function cmd_bench(args)
  local fl = parse_flags(args, { suite = "string", out = "string" })
  if not fl.suite or fl.suite == "" then die("--suite is required") end
  local suite, err = bench.load_suite(fl.suite)
  if not suite then die(tostring(err)) end
  local res, rerr = bench.run(suite, io.stderr)
  if not res then die(tostring(rerr)) end
  local data = json.encode(res, "  ") .. "\n"
  local s = res.summary
  io.stderr:write(string.format(
    "[%s] checksum=%s games=%d moves=%d wall=%.0fms moves/s=%.0f games/s=%.2f nodes/s=%.0f\n",
    suite.id, res.checksum, s.games, s.totalMoves, s.wallMs, s.movesPerSec, s.gamesPerSec, s.nodesPerSec))
  if not fl.out or fl.out == "" then
    io.stdout:write(data)
    return
  end
  local d = fl.out:match("^(.*)/[^/]*$")
  if d and d ~= "" then os.execute("mkdir -p '" .. d:gsub("'", "'\\''") .. "'") end
  local f, ferr = io.open(fl.out, "wb")
  if not f then die(tostring(ferr)) end
  f:write(data)
  f:close()
end

--- Agent config map from CLI flags.
local function agent_config(depth)
  local cfg = {}
  if depth and depth ~= "" and depth ~= "auto" then
    local n = math.tointeger(tonumber(depth))
    if not n or n < 1 then return nil, "--depth must be 'auto' or a positive integer" end
    cfg.depth = n
  end
  return cfg
end

local function cmd_play(args)
  local fl = parse_flags(args, { seed = "string", agent = "string", depth = "string", ["max-moves"] = "string" })
  local seed = ids.random_seed()
  if fl.seed and fl.seed ~= "" then
    local n = math.tointeger(tonumber(fl.seed))
    if not n or n < 0 or n > 0xffffffff or not fl.seed:match("^%d+$") then die("--seed must be a uint32") end
    seed = n
  end
  local agent_id = fl.agent or "expectimax"
  local cfg, cerr = agent_config(fl.depth or "auto")
  if not cfg then die(cerr) end
  local agent, aerr = agents.new(agent_id, cfg)
  if not agent then die(aerr) end
  local max_moves = math.tointeger(tonumber(fl["max-moves"] or "0")) or 0
  local pr, perr = bench.play(agent, seed, max_moves, nil)
  if not pr then die(perr) end
  local snap = pr.game:snapshot()
  local out = json.obj({
    "seed", snap.seed,
    "board", snap.board,
    "score", snap.score,
    "moveCount", snap.moveCount,
    "maxTile", snap.maxTile,
    "over", snap.over,
    "historyHash", snap.historyHash,
    "specVersion", game.SPEC_VERSION,
    "agent", agent_id,
    "nodes", pr.nodes,
    "wallMs", pr.wallMs + 0.0,
    "moves", pr.game:moves_string(),
  })
  print(json.encode(out, "  "))
end

local cmd = arg[1]
local rest = { table.unpack(arg, 2) }
if cmd == nil then
  io.stderr:write(USAGE)
  os.exit(2)
elseif cmd == "validate" then
  cmd_validate(rest)
elseif cmd == "bench" then
  cmd_bench(rest)
elseif cmd == "play" then
  cmd_play(rest)
elseif cmd == "-h" or cmd == "--help" or cmd == "help" then
  io.stdout:write(USAGE)
else
  io.stderr:write(string.format("unknown command %q\n\n%s", cmd, USAGE))
  os.exit(2)
end
