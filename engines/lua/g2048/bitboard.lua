-- AI.md §1: 64-bit bitboard (cell i in bits 4i..4i+3) with 65536-entry line
-- tables. Lua 5.4 integers are 64-bit two's complement; `>>` is a logical
-- shift, so a board with bit 63 set still extracts correctly.

local M = {}

-- line tables, indexed by the 16-bit line value (0..65535)
local LOW = {}   -- slide toward the low nibble ("left" for rows, "up" for columns)
local HIGH = {}  -- slide toward the high nibble ("right" / "down")
local EMPTY = {} -- number of zero nibbles in the line

local function reverse_line(v)
  return ((v & 0xf) << 12) | (((v >> 4) & 0xf) << 8) | (((v >> 8) & 0xf) << 4) | ((v >> 12) & 0xf)
end

for v = 0, 65535 do
  local r = { v & 0xf, (v >> 4) & 0xf, (v >> 8) & 0xf, (v >> 12) & 0xf }
  local tiles, n = {}, 0
  local e = 0
  for k = 1, 4 do
    if r[k] ~= 0 then
      n = n + 1
      tiles[n] = r[k]
    else
      e = e + 1
    end
  end
  local out, o = { 0, 0, 0, 0 }, 0
  local i = 1
  while i <= n do
    o = o + 1
    if i < n and tiles[i] == tiles[i + 1] then
      out[o] = math.min(tiles[i] + 1, 15)
      i = i + 2
    else
      out[o] = tiles[i]
      i = i + 1
    end
  end
  LOW[v] = out[1] | (out[2] << 4) | (out[3] << 8) | (out[4] << 12)
  EMPTY[v] = e
end
for v = 0, 65535 do
  HIGH[v] = reverse_line(LOW[reverse_line(v)])
end

M.LOW, M.HIGH, M.EMPTY = LOW, HIGH, EMPTY

--- Transpose the 4x4 nibble matrix (rows <-> columns). Row c of the result is
--- column c of the input with row 0 in the lowest nibble.
local function transpose(x)
  local a1 = x & 0xF0F00F0FF0F00F0F
  local a2 = x & 0x0000F0F00000F0F0
  local a3 = x & 0x0F0F00000F0F0000
  local a = a1 | (a2 << 12) | (a3 >> 12)
  local b1 = a & 0xFF00FF0000FF00FF
  local b2 = a & 0x00FF00FF00000000
  local b3 = a & 0x00000000FF00FF00
  return b1 | (b2 >> 24) | (b3 << 24)
end
M.transpose = transpose

--- Column c as a line value (row 0 in the lowest nibble).
function M.column(b, c)
  local x = b >> (4 * c)
  return (x & 0xf) | ((x >> 12) & 0xf0) | ((x >> 24) & 0xf00) | ((x >> 36) & 0xf000)
end

--- Apply dir (saturating at rank 15). Returns (new board, changed).
function M.move(b, dir)
  local nb
  if dir == 2 or dir == 3 then
    local t = dir == 2 and LOW or HIGH
    nb = t[b & 0xffff] | (t[(b >> 16) & 0xffff] << 16) | (t[(b >> 32) & 0xffff] << 32) | (t[b >> 48] << 48)
  else
    local t = dir == 0 and LOW or HIGH
    local x = transpose(b)
    x = t[x & 0xffff] | (t[(x >> 16) & 0xffff] << 16) | (t[(x >> 32) & 0xffff] << 32) | (t[x >> 48] << 48)
    nb = transpose(x)
  end
  return nb, nb ~= b
end

--- Convert a game board (1-based exponent array), clamping above 15.
function M.from_board(board)
  local b = 0
  for i = 0, 15 do
    local e = board[i + 1]
    if e > 15 then e = 15 end
    b = b | (e << (4 * i))
  end
  return b
end

--- Convert back to a game board.
function M.to_board(b)
  local out = {}
  for i = 0, 15 do out[i + 1] = (b >> (4 * i)) & 0xf end
  return out
end

--- Number of distinct non-zero ranks.
function M.distinct_ranks(b)
  local mask = 0
  for i = 0, 15 do
    mask = mask | (1 << ((b >> (4 * i)) & 0xf))
  end
  mask = mask & ~1
  local n = 0
  while mask ~= 0 do
    mask = mask & (mask - 1)
    n = n + 1
  end
  return n
end

function M.count_empty(b)
  return EMPTY[b & 0xffff] + EMPTY[(b >> 16) & 0xffff] + EMPTY[(b >> 32) & 0xffff] + EMPTY[b >> 48]
end

return M
