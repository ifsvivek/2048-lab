-- Built-in agents: SPEC §10 random, greedy, and canonical expectimax.
--
-- Agent contract:
--   agent.id                       "random" | "greedy" | "expectimax"
--   agent:reset(seed)              once per game, before the first decision
--   agent:decide(board) -> move, metrics   (board is a 1-based exponent array)
--   agent:config_json()            effective config (nil if none)
--   agent:deterministic()

local board = require("g2048.board")
local rng = require("g2048.rng")
local bitboard = require("g2048.bitboard")
local heuristic = require("g2048.heuristic")
local expectimax = require("g2048.expectimax")
local json = require("g2048.json")

local M = {}

local clock = os.clock
local can_move = board.can_move

local function us_since(t0)
  return math.floor((clock() - t0) * 1e6 + 0.5)
end

---------------------------------------------------------------------------
-- random (SPEC §10)

local Random = {}
Random.__index = Random

function M.random()
  return setmetatable({ id = "random", rng = rng.from_seed(0) }, Random)
end

function Random:reset(seed)
  self.rng = rng.from_seed((seed ~ 0xA5A5A5A5) & 0xffffffff)
end

function Random:decide(b, timed)
  local t0 = timed and clock()
  local v1, v2, v3, v4
  local n = 0
  for d = 0, 3 do
    if can_move(b, d) then
      n = n + 1
      if n == 1 then v1 = d elseif n == 2 then v2 = d elseif n == 3 then v3 = d else v4 = d end
    end
  end
  local k = self.rng:below(n)
  local mv
  if k == 0 then mv = v1 elseif k == 1 then mv = v2 elseif k == 2 then mv = v3 else mv = v4 end
  return mv, { timeUs = timed and us_since(t0) or 0, deterministic = true }
end

function Random:config_json() return nil end

function Random:deterministic() return true end

---------------------------------------------------------------------------
-- greedy: maximise empty cells after the move; ties go to the lower direction

local Greedy = {}
Greedy.__index = Greedy

function M.greedy()
  return setmetatable({ id = "greedy" }, Greedy)
end

function Greedy:reset() end

function Greedy:decide(b)
  local t0 = clock()
  local bb = bitboard.from_board(b)
  local best = board.valid_moves(b)[1] or -1
  local best_score = -1
  for d = 0, 3 do
    local nb, ok = bitboard.move(bb, d)
    if ok then
      local empty = bitboard.count_empty(nb)
      if empty > best_score then best_score, best = empty, d end
    end
  end
  return best, { timeUs = us_since(t0), deterministic = true }
end

function Greedy:config_json() return nil end

function Greedy:deterministic() return true end

---------------------------------------------------------------------------
-- expectimax

local Expectimax = {}
Expectimax.__index = Expectimax

function M.expectimax(cfg)
  return setmetatable({ id = "expectimax", search = expectimax.new_search(cfg), config = cfg }, Expectimax)
end

function Expectimax:reset() end

function Expectimax:decide(b)
  local bb = bitboard.from_board(b)
  local r = self.search.run(bb)
  self.last_result = r
  local mv = r.move
  if mv < 0 then mv = board.valid_moves(b)[1] or -1 end
  return mv, {
    depth = r.depth,
    nodes = r.nodes,
    ttHits = r.ttHits,
    ttSize = r.ttSize,
    timeUs = r.timeUs,
    values = r.values,
    heuristic = self.with_heuristic and heuristic.breakdown(bb, self.config.weights) or nil,
    deterministic = r.deterministic,
    completedDepths = r.completedDepths,
  }
end

function Expectimax:config_json()
  return expectimax.config_json(self.config)
end

function Expectimax:deterministic()
  return not ((self.config.timeBudgetMs or 0) > 0)
end

---------------------------------------------------------------------------

--- Create a built-in agent. Returns agent or nil, err.
function M.new(id, config)
  if id == "random" then
    return M.random()
  elseif id == "greedy" then
    return M.greedy()
  elseif id == "expectimax" then
    local cfg, err = expectimax.parse_config(config)
    if not cfg then return nil, err end
    return M.expectimax(cfg)
  end
  return nil, string.format("unknown agent '%s'", tostring(id))
end

--- Per-decision metrics as an ordered JSON object (AI.md §4).
function M.metrics_json(m)
  local values
  if m.values then
    values = json.array({ m.values[0], m.values[1], m.values[2], m.values[3] })
  end
  local h
  if m.heuristic then
    local x = m.heuristic
    h = json.obj({ "empty", x.empty, "merges", x.merges, "mono", x.mono, "sum", x.sum, "smooth", x.smooth,
      "stable", x.stable, "corner", x.corner, "total", x.total })
  end
  return json.obj({
    "depth", m.depth,
    "nodes", m.nodes,
    "ttHits", m.ttHits,
    "ttSize", m.ttSize,
    "timeUs", m.timeUs,
    "values", values,
    "heuristic", h,
    "deterministic", m.deterministic,
    "completedDepths", m.completedDepths and json.array(m.completedDepths) or nil,
  })
end

return M
