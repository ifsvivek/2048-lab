-- AI.md §2: integer heuristic, per-line tables, corner term, breakdown.
--
-- Line scores are stored as Lua integers: every value is an exact integer
-- below 2^53, so summing integers and converting once gives the same float64
-- as the reference's float additions.

local bitboard = require("g2048.bitboard")

local M = {}

M.WEIGHT_KEYS = { "lost", "empty", "merges", "mono", "sum", "smooth", "stable", "corner" }
M.FEATURE_KEYS = { "empty", "merges", "mono", "sum", "smooth", "stable" }

function M.heuristic_v1()
  return { lost = 200000, empty = 270, merges = 700, mono = 47, sum = 11, smooth = 0, stable = 0, corner = 0 }
end

function M.copy_weights(w)
  local c = {}
  for _, k in ipairs(M.WEIGHT_KEYS) do c[k] = w[k] or 0 end
  return c
end

function M.weights_equal(a, b)
  for _, k in ipairs(M.WEIGHT_KEYS) do
    if (a[k] or 0) ~= (b[k] or 0) then return false end
  end
  return true
end

--- Features of a 16-bit line value.
function M.features(v)
  local r = { v & 0xf, (v >> 4) & 0xf, (v >> 8) & 0xf, (v >> 12) & 0xf }
  local empty, merges, sum, smooth, stable = 0, 0, 0, 0, 0
  local prev, counter = 0, 0
  for i = 1, 4 do
    local rank = r[i]
    sum = sum + rank * rank * rank
    if rank == 0 then
      empty = empty + 1
    else
      if prev == rank then
        counter = counter + 1
      elseif counter > 0 then
        merges = merges + 1 + counter
        counter = 0
      end
      prev = rank
    end
  end
  if counter > 0 then merges = merges + 1 + counter end
  local monoL, monoR = 0, 0
  for i = 2, 4 do
    local p, q = r[i - 1], r[i]
    local a, b = p * p * p * p, q * q * q * q
    if r[i - 1] > r[i] then
      monoL = monoL + a - b
    else
      monoR = monoR + b - a
    end
    if r[i - 1] ~= 0 and r[i] ~= 0 then
      smooth = smooth + math.abs(r[i - 1] - r[i])
    end
  end
  if empty == 0 and (monoL == 0 or monoR == 0) then stable = 1 end
  return {
    empty = empty,
    merges = merges,
    mono = math.min(monoL, monoR),
    sum = sum,
    smooth = smooth,
    stable = stable,
  }
end

--- Weighted line score (integer).
function M.line_score(f, w)
  return w.lost + w.empty * f.empty + w.merges * f.merges - w.mono * f.mono - w.sum * f.sum
    - w.smooth * f.smooth + w.stable * f.stable
end

local cache = {}

local function weights_key(w)
  local parts = {}
  for i, k in ipairs(M.WEIGHT_KEYS) do parts[i] = tostring(w[k] or 0) end
  return table.concat(parts, ",")
end

--- Memoised 65536-entry line-score table (integer values, index 0..65535).
function M.line_table(w)
  local key = weights_key(w)
  local t = cache[key]
  if t then return t end
  t = {}
  local fw = M.copy_weights(w)
  for v = 0, 65535 do
    t[v] = M.line_score(M.features(v), fw)
  end
  cache[key] = t
  return t
end

--- W.corner * maxRank if a corner holds the max rank, else 0 (integer).
function M.corner_term(b, corner_weight)
  if corner_weight == 0 then return 0 end
  local mx = 0
  for i = 0, 15 do
    local n = (b >> (4 * i)) & 0xf
    if n > mx then mx = n end
  end
  if (b & 0xf) == mx or ((b >> 12) & 0xf) == mx or ((b >> 48) & 0xf) == mx or (b >> 60) == mx then
    return corner_weight * mx
  end
  return 0
end

--- Heuristic value of a bitboard as a float.
function M.evaluate(b, t, corner_weight)
  local x = bitboard.transpose(b)
  local v = t[b & 0xffff] + t[(b >> 16) & 0xffff] + t[(b >> 32) & 0xffff] + t[b >> 48]
    + t[x & 0xffff] + t[(x >> 16) & 0xffff] + t[(x >> 32) & 0xffff] + t[x >> 48]
  if corner_weight ~= 0 then v = v + M.corner_term(b, corner_weight) end
  return v + 0.0
end

--- Heuristic decomposition summed over all 8 lines.
function M.breakdown(b, w)
  local x = bitboard.transpose(b)
  local lines = {
    b & 0xffff, (b >> 16) & 0xffff, (b >> 32) & 0xffff, b >> 48,
    x & 0xffff, (x >> 16) & 0xffff, (x >> 32) & 0xffff, x >> 48,
  }
  local acc = { empty = 0, merges = 0, mono = 0, sum = 0, smooth = 0, stable = 0 }
  for _, v in ipairs(lines) do
    local f = M.features(v)
    for _, k in ipairs(M.FEATURE_KEYS) do acc[k] = acc[k] + f[k] end
  end
  local corner = w.corner or 0
  acc.corner = M.corner_term(b, corner) + 0.0
  acc.total = M.evaluate(b, M.line_table(w), corner)
  return acc
end

return M
