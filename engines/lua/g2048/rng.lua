-- SPEC §4: mix32 seed expansion and the xoshiro128** generator.
--
-- Lua 5.4 integers are 64-bit, so every uint32 operation is masked with
-- 0xffffffff. A product of two 32-bit values wraps modulo 2^64, which keeps
-- its low 32 bits exact, so `(a * b) & MASK` is a correct imul.

local M = {}

local MASK = 0xffffffff
M.MASK = MASK

--- Expand a seed into four state words (SPEC §4.1). Returns a 1-based array.
function M.mix32(seed)
  local s = {}
  local x = seed & MASK
  for k = 1, 4 do
    x = (x + 0x9E3779B9) & MASK
    local z = x
    z = ((z ~ (z >> 16)) * 0x85EBCA6B) & MASK
    z = ((z ~ (z >> 13)) * 0xC2B2AE35) & MASK
    s[k] = z ~ (z >> 16)
  end
  if s[1] == 0 and s[2] == 0 and s[3] == 0 and s[4] == 0 then s[1] = 1 end
  return s
end

local Rng = {}
Rng.__index = Rng
M.Rng = Rng

--- Create a generator from explicit state {s0, s1, s2, s3}.
function M.new(state)
  return setmetatable({ state[1] & MASK, state[2] & MASK, state[3] & MASK, state[4] & MASK }, Rng)
end

--- Create a generator from a seed via mix32.
function M.from_seed(seed)
  return M.new(M.mix32(seed))
end

--- Next 32-bit output (SPEC §4.2).
function Rng:next()
  local s0, s1, s2, s3 = self[1], self[2], self[3], self[4]
  local r = (s1 * 5) & MASK
  r = ((r << 7) | (r >> 25)) & MASK
  r = (r * 9) & MASK
  local t = (s1 << 9) & MASK
  s2 = s2 ~ s0
  s3 = s3 ~ s1
  s1 = s1 ~ s2
  s0 = s0 ~ s3
  s2 = s2 ~ t
  s3 = ((s3 << 11) | (s3 >> 21)) & MASK
  self[1], self[2], self[3], self[4] = s0, s1, s2, s3
  return r
end

local TWO32 = 1 << 32

--- Unbiased integer in [0, n), 1 <= n <= 2^32 (SPEC §4.3).
function Rng:below(n)
  local limit = TWO32 - TWO32 % n
  while true do
    local x = self:next()
    if x < limit then return x % n end
  end
end

--- Copy of the state as a 1-based array.
function Rng:state()
  return { self[1], self[2], self[3], self[4] }
end

function Rng:clone()
  return setmetatable({ self[1], self[2], self[3], self[4] }, Rng)
end

return M
