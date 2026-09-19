-- AI.md §3: canonical expectimax with an exact-key transposition table.
--
-- The hot functions are closures over per-search locals (line table, TT
-- arrays, counters) because upvalue access is much cheaper than table
-- fields in the Lua VM.
--
-- Floating point: `sum = sum + 0.9 * v` compiles to separate MUL and ADD VM
-- instructions, so there is no fused multiply-add and the products are
-- rounded to float64 before the addition, exactly as AI.md requires. Leaf
-- evaluations are exact integers (< 2^53), computed incrementally: a spawned
-- tile at (r, c) only changes row r and column c, so the child's value is the
-- parent's line sum with those two line scores replaced. Integer addition of
-- exact values equals the reference's float additions.
--
-- The transposition table mirrors the TypeScript reference (slot hash, 4-slot
-- probe, store policy, clear at 75 % occupancy, 2^ttBits slots), so node and
-- ttHits counts match the other reference-policy ports.

local bitboard = require("g2048.bitboard")
local heuristic = require("g2048.heuristic")
local json = require("g2048.json")

local M = {}

local LOW, HIGH, EMPTY = bitboard.LOW, bitboard.HIGH, bitboard.EMPTY
local transpose = bitboard.transpose
local clock = os.clock

--- Canonical profile.
function M.canonical_config()
  return {
    autoDepth = true,
    depth = 0,
    minDepth = 2,
    maxDepth = 4,
    fourPruneEmpties = 0,
    timeBudgetMs = 0,
    ttBits = 20,
    weights = heuristic.heuristic_v1(),
  }
end

local function as_int(key, v)
  if math.type(v) == "integer" then return v end
  if math.type(v) == "float" then
    if v ~= v or v == math.huge or v == -math.huge or v ~= math.floor(v) then
      return nil, string.format("config %s must be an integer (got %s)", key, json.format_float(v ~= v and 0 or v))
    end
    return math.tointeger(v)
  end
  return nil, string.format("config %s must be a number", key)
end

--- Overlay a JSON-decoded config object onto the canonical profile.
--- Returns config or nil, err.
function M.parse_config(m)
  local c = M.canonical_config()
  if m == nil or m == json.null then return c end
  if type(m) ~= "table" then return nil, "config must be an object" end
  local keys = json.keys(m)
  if not keys then
    keys = {}
    for k in pairs(m) do keys[#keys + 1] = k end
    table.sort(keys)
  end
  for _, k in ipairs(keys) do
    local v = m[k]
    local n, err
    if k == "depth" then
      if type(v) == "string" then
        if v ~= "auto" then return nil, 'config depth must be an integer or "auto"' end
        c.autoDepth = true
      else
        n, err = as_int(k, v)
        if n then
          c.autoDepth, c.depth = false, n
          if n < 1 then err = "config depth must be >= 1" end
        end
      end
    elseif k == "minDepth" then
      n, err = as_int(k, v)
      c.minDepth = n or c.minDepth
    elseif k == "maxDepth" then
      n, err = as_int(k, v)
      c.maxDepth = n or c.maxDepth
    elseif k == "fourPruneEmpties" then
      n, err = as_int(k, v)
      c.fourPruneEmpties = n or c.fourPruneEmpties
    elseif k == "timeBudgetMs" then
      if type(v) ~= "number" then
        err = "config timeBudgetMs must be a number"
      else
        c.timeBudgetMs = v
      end
    elseif k == "ttBits" then
      n, err = as_int(k, v)
      if n then
        if n < 4 or n > 28 then err = "config ttBits out of range" end
        c.ttBits = n
      end
    elseif k == "weights" then
      if type(v) ~= "table" or json.is_array(v) or v == json.null then
        return nil, "config weights must be an object"
      end
      for wk, wv in pairs(v) do
        local wn = as_int("weights." .. wk, wv)
        if wn == nil then
          return nil, string.format("heuristic weight '%s' must be an integer (got %s)", wk, tostring(wv))
        end
        if c.weights[wk] ~= nil then c.weights[wk] = wn end
      end
    end
    if err then return nil, err end
  end
  return c
end

--- Effective configuration as an ordered JSON object (TS descriptor shape).
function M.config_json(c)
  local w = json.obj({})
  for _, k in ipairs(heuristic.WEIGHT_KEYS) do json.set(w, k, c.weights[k]) end
  local budget = c.timeBudgetMs
  if math.type(budget) == "integer" then budget = budget + 0.0 end
  return json.obj({
    "depth", c.autoDepth and "auto" or c.depth,
    "minDepth", c.minDepth,
    "maxDepth", c.maxDepth,
    "fourPruneEmpties", c.fourPruneEmpties,
    "timeBudgetMs", budget,
    "ttBits", c.ttBits,
    "weights", w,
  })
end

local ABORT = setmetatable({}, { __tostring = function() return "search aborted" end })

--- Create a reusable searcher (preallocates the transposition table).
function M.new_search(cfg)
  if not cfg.ttBits or cfg.ttBits == 0 then cfg.ttBits = 20 end
  local self = { config = cfg }

  local T = heuristic.line_table(cfg.weights)
  local corner = cfg.weights.corner or 0
  local prune = cfg.fourPruneEmpties or 0

  local size = 1 << cfg.ttBits
  local mask = size - 1
  local ttb, ttd, ttv = {}, {}, {}
  for i = 0, mask do
    ttb[i] = 0
    ttd[i] = 0
    ttv[i] = 0.0
  end
  local ttsize = 0

  local nodes, hits = 0, 0
  local timed, deadline = false, 0.0

  local function evaluate(b)
    local x = transpose(b)
    local v = T[b & 0xffff] + T[(b >> 16) & 0xffff] + T[(b >> 32) & 0xffff] + T[b >> 48]
      + T[x & 0xffff] + T[(x >> 16) & 0xffff] + T[(x >> 32) & 0xffff] + T[x >> 48]
    if corner ~= 0 then v = v + heuristic.corner_term(b, corner) end
    return v
  end
  self.evaluate = function(b) return evaluate(b) + 0.0 end

  local chance

  local function maxnode(b, d)
    nodes = nodes + 1
    if d == 0 then return evaluate(b) end
    local best = 0.0
    -- transpose(b): columns become rows
    local a = (b & 0xF0F00F0FF0F00F0F) | ((b & 0x0000F0F00000F0F0) << 12) | ((b & 0x0F0F00000F0F0000) >> 12)
    local x = (a & 0xFF00FF0000FF00FF) | ((a & 0x00FF00FF00000000) >> 24) | ((a & 0x00000000FF00FF00) << 24)
    local c0, c1, c2, c3 = x & 0xffff, (x >> 16) & 0xffff, (x >> 32) & 0xffff, x >> 48
    -- up
    local m = LOW[c0] | (LOW[c1] << 16) | (LOW[c2] << 32) | (LOW[c3] << 48)
    if m ~= x then
      local v = chance(transpose(m), d)
      if v > best then best = v end
    end
    -- down
    m = HIGH[c0] | (HIGH[c1] << 16) | (HIGH[c2] << 32) | (HIGH[c3] << 48)
    if m ~= x then
      local v = chance(transpose(m), d)
      if v > best then best = v end
    end
    local r0, r1, r2, r3 = b & 0xffff, (b >> 16) & 0xffff, (b >> 32) & 0xffff, b >> 48
    -- left
    m = LOW[r0] | (LOW[r1] << 16) | (LOW[r2] << 32) | (LOW[r3] << 48)
    if m ~= b then
      local v = chance(m, d)
      if v > best then best = v end
    end
    -- right
    m = HIGH[r0] | (HIGH[r1] << 16) | (HIGH[r2] << 32) | (HIGH[r3] << 48)
    if m ~= b then
      local v = chance(m, d)
      if v > best then best = v end
    end
    return best
  end

  chance = function(b, d)
    nodes = nodes + 1
    if timed and nodes & 0xfff == 0 and clock() > deadline then error(ABORT, 0) end

    -- TS TranspositionTable.slot hash of (lo, hi, d), uint32 arithmetic
    local h = (((b & 0xffffffff) ~ (d * 0x9e3779b1)) * 0x85ebca6b ~ ((b >> 32) * 0xc2b2ae35)) & 0xffffffff
    h = h ~ (h >> 15)
    h = (h * 0x2c1b3c6d) & 0xffffffff
    h = h ~ (h >> 12)
    local home = h & mask
    local sl = home
    for _ = 1, 4 do
      local sd = ttd[sl]
      if sd == 0 then break end
      if sd == d and ttb[sl] == b then
        hits = hits + 1
        return ttv[sl]
      end
      sl = (sl + 1) & mask
    end

    local r0, r1, r2, r3 = b & 0xffff, (b >> 16) & 0xffff, (b >> 32) & 0xffff, b >> 48
    local n = EMPTY[r0] + EMPTY[r1] + EMPTY[r2] + EMPTY[r3]
    local four = not (prune > 0 and n >= prune)
    local sum = 0.0

    if d == 1 and corner == 0 then
      -- children are leaves: evaluate incrementally from the parent's lines
      local x = transpose(b)
      local c0, c1, c2, c3 = x & 0xffff, (x >> 16) & 0xffff, (x >> 32) & 0xffff, x >> 48
      local base = T[r0] + T[r1] + T[r2] + T[r3] + T[c0] + T[c1] + T[c2] + T[c3]
      for r = 0, 3 do
        local rsh = 4 * r
        local row = (b >> (rsh << 2)) & 0xffff
        if EMPTY[row] ~= 0 then
          local rbase = base - T[row]
          for c = 0, 3 do
            local csh = 4 * c
            if (row >> csh) & 0xf == 0 then
              local col = (x >> (csh << 2)) & 0xffff
              local cb = rbase - T[col]
              if four then
                local v2 = cb + T[row | (1 << csh)] + T[col | (1 << rsh)]
                sum = sum + 0.9 * v2
                local v4 = cb + T[row | (2 << csh)] + T[col | (2 << rsh)]
                sum = sum + 0.1 * v4
                nodes = nodes + 2
              else
                sum = sum + (cb + T[row | (1 << csh)] + T[col | (1 << rsh)])
                nodes = nodes + 1
              end
            end
          end
        end
      end
    else
      local dm1 = d - 1
      local tile = 1
      for _ = 0, 15 do
        if b & (tile * 15) == 0 then
          if four then
            local v2 = maxnode(b | tile, dm1)
            sum = sum + 0.9 * v2
            local v4 = maxnode(b | (tile << 1), dm1)
            sum = sum + 0.1 * v4
          else
            sum = sum + maxnode(b | tile, dm1)
          end
        end
        tile = tile << 4
      end
    end
    local v = sum / n

    local target = home
    sl = home
    for _ = 1, 4 do
      if ttd[sl] == 0 then
        target = sl
        ttsize = ttsize + 1
        break
      end
      sl = (sl + 1) & mask
    end
    ttb[target] = b
    ttd[target] = d
    ttv[target] = v
    return v
  end

  local function root(b, depth)
    local best, best_value = -1, -math.huge
    local values = { [0] = json.null, json.null, json.null, json.null }
    for dir = 0, 3 do
      local nb, ok = bitboard.move(b, dir)
      if ok then
        local v = chance(nb, depth)
        values[dir] = v
        if v > best_value then
          best, best_value = dir, v
        end
      end
    end
    return { move = best, value = best_value, values = values }
  end

  function self.depth_for(b)
    if not cfg.autoDepth then return cfg.depth end
    return math.max(cfg.minDepth, math.min(cfg.maxDepth, bitboard.distinct_ranks(b) - 2))
  end

  local function result(r, depth, start, det, completed)
    return {
      move = r.move,
      value = r.value,
      values = r.values,
      depth = depth,
      nodes = nodes,
      ttHits = hits,
      ttSize = ttsize,
      timeUs = math.floor((clock() - start) * 1e6 + 0.5),
      deterministic = det,
      completedDepths = completed,
    }
  end

  --- Search b and return the decision.
  function self.run(b)
    local start = clock()
    nodes, hits = 0, 0
    timed = false
    if ttsize > size * 0.75 then
      for i = 0, mask do ttd[i] = 0 end
      ttsize = 0
    end
    local budget = cfg.timeBudgetMs or 0
    if not (budget > 0) then
      local depth = self.depth_for(b)
      return result(root(b, depth), depth, start, true, { depth })
    end
    local best = root(b, 1)
    local depth = 1
    local completed = { 1 }
    timed = true
    deadline = start + budget / 1000
    for d = 2, cfg.maxDepth do
      local ok, r = pcall(root, b, d)
      if not ok then
        if r ~= ABORT then
          timed = false
          error(r, 0)
        end
        break
      end
      best, depth = r, d
      completed[#completed + 1] = d
    end
    timed = false
    return result(best, depth, start, false, completed)
  end

  self.stats = function() return nodes, hits, ttsize end
  return self
end

return M
