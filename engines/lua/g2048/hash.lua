-- SPEC §7: FNV-1a 32-bit board and history hashes.

local M = {}

local MASK = 0xffffffff
local OFFSET = 0x811C9DC5
local PRIME = 0x01000193

--- fnv1a32 over the bytes of a string.
function M.fnv1a32(s)
  local h = OFFSET
  for i = 1, #s do
    h = ((h ~ s:byte(i)) * PRIME) & MASK
  end
  return h
end

--- fnv1a32 over the 16 exponent bytes.
function M.board_hash(b)
  local h = OFFSET
  for i = 1, 16 do
    h = ((h ~ b[i]) * PRIME) & MASK
  end
  return h
end

--- fnv1a32(le32(h) ++ 16 board bytes ++ [dir]).
function M.history_step(h, b, dir)
  local x = OFFSET
  for k = 0, 3 do
    x = ((x ~ ((h >> (8 * k)) & 0xff)) * PRIME) & MASK
  end
  for i = 1, 16 do
    x = ((x ~ b[i]) * PRIME) & MASK
  end
  return ((x ~ dir) * PRIME) & MASK
end

--- 8 lowercase hex digits.
function M.hex(h)
  return string.format("%08x", h)
end

return M
