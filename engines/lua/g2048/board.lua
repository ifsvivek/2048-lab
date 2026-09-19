-- SPEC §1-3, §5: exponent boards, directions, moves and spawning.
--
-- A board is a Lua array of 16 exponents; cell index i (row-major, SPEC §1)
-- is stored at b[i + 1].

local M = {}

M.UP, M.DOWN, M.LEFT, M.RIGHT = 0, 1, 2, 3
M.LETTERS = "UDLR"
M.NAMES = { [0] = "up", "down", "left", "right" }

-- LINES[dir][line] = 1-based positions, starting at the edge tiles slide toward.
local LINES = {}
for dir = 0, 3 do LINES[dir] = {} end
for k = 0, 3 do
  local up, down, left, right = {}, {}, {}, {}
  for j = 0, 3 do
    up[j + 1] = j * 4 + k + 1
    down[j + 1] = (3 - j) * 4 + k + 1
    left[j + 1] = k * 4 + j + 1
    right[j + 1] = k * 4 + 3 - j + 1
  end
  LINES[0][k + 1], LINES[1][k + 1], LINES[2][k + 1], LINES[3][k + 1] = up, down, left, right
end
M.LINES = LINES

local HEX = "0123456789abcdefghijklmnopqrstuvwxyz"
local HEX_CHARS, HEX_VALUE = {}, {}
for i = 0, 35 do
  local c = HEX:sub(i + 1, i + 1)
  HEX_CHARS[i] = c
  HEX_VALUE[c] = i
  HEX_VALUE[c:upper()] = i
end

function M.empty()
  return { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }
end

function M.copy(b)
  return { b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15], b[16] }
end

function M.equal(a, b)
  for i = 1, 16 do
    if a[i] ~= b[i] then return false end
  end
  return true
end

--- Canonical boardHex encoding.
function M.to_hex(b)
  local s = {}
  for i = 1, 16 do s[i] = HEX_CHARS[b[i]] end
  return table.concat(s)
end

--- Decode boardHex. Returns board or nil, err.
function M.from_hex(hex)
  if type(hex) ~= "string" or #hex ~= 16 then
    return nil, string.format("boardHex must be 16 chars, got %d", type(hex) == "string" and #hex or 0)
  end
  local b = {}
  for i = 1, 16 do
    local c = hex:sub(i, i)
    local v = HEX_VALUE[c]
    if not v then return nil, string.format("invalid boardHex character '%s'", c) end
    b[i] = v
  end
  return b
end

--- Decode boardHex, raising on error.
function M.must(hex)
  local b, err = M.from_hex(hex)
  if not b then error(err, 2) end
  return b
end

--- Convert a value matrix (0 = empty, powers of two) to a board.
function M.from_matrix(m)
  if type(m) ~= "table" or #m ~= 4 then return nil, "board must have 4 rows" end
  local b = M.empty()
  for r = 1, 4 do
    local row = m[r]
    if type(row) ~= "table" or #row ~= 4 then
      return nil, string.format("board row %d must have 4 cells", r - 1)
    end
    for c = 1, 4 do
      local v = math.tointeger(row[c])
      if v == nil then return nil, "invalid tile value " .. tostring(row[c]) end
      if v ~= 0 then
        if v < 2 or v & (v - 1) ~= 0 then return nil, string.format("invalid tile value %d", v) end
        local e = 0
        while v > 1 do
          v = v >> 1
          e = e + 1
        end
        if e > 35 then return nil, "tile too large" end
        b[(r - 1) * 4 + c] = e
      end
    end
  end
  return b
end

--- Tile values as matrix[row][col] (1-based).
function M.to_matrix(b)
  local m = {}
  for r = 0, 3 do
    local row = {}
    for c = 0, 3 do
      local e = b[r * 4 + c + 1]
      row[c + 1] = e ~= 0 and (1 << e) or 0
    end
    m[r + 1] = row
  end
  return m
end

function M.max_exponent(b)
  local m = 0
  for i = 1, 16 do
    if b[i] > m then m = b[i] end
  end
  return m
end

--- Largest tile value (0 for an empty board).
function M.max_tile(b)
  local e = M.max_exponent(b)
  if e == 0 then return 0 end
  return 1 << e
end

--- Apply dir in place. Returns the score gained, or -1 if the move is
--- invalid (board untouched).
function M.move_in_place(b, dir)
  local gained = 0
  local changed = false
  local lines = LINES[dir]
  for l = 1, 4 do
    local idx = lines[l]
    local p1, p2, p3, p4 = idx[1], idx[2], idx[3], idx[4]
    local a1, a2, a3, a4 = b[p1], b[p2], b[p3], b[p4]
    -- compact non-zero tiles
    local t1, t2, t3, t4 = 0, 0, 0, 0
    local n = 0
    if a1 ~= 0 then n = 1; t1 = a1 end
    if a2 ~= 0 then n = n + 1; if n == 1 then t1 = a2 else t2 = a2 end end
    if a3 ~= 0 then
      n = n + 1
      if n == 1 then t1 = a3 elseif n == 2 then t2 = a3 else t3 = a3 end
    end
    if a4 ~= 0 then
      n = n + 1
      if n == 1 then t1 = a4 elseif n == 2 then t2 = a4 elseif n == 3 then t3 = a4 else t4 = a4 end
    end
    if n > 0 then
      local r1, r2, r3, r4 = 0, 0, 0, 0
      if t1 == t2 then -- t1 ~= 0 because n > 0
        r1 = t1 + 1
        gained = gained + (1 << r1)
        if t3 ~= 0 and t3 == t4 then
          r2 = t3 + 1
          gained = gained + (1 << r2)
        else
          r2, r3 = t3, t4
        end
      else
        r1 = t1
        if t2 ~= 0 and t2 == t3 then
          r2 = t2 + 1
          gained = gained + (1 << r2)
          r3 = t4
        else
          r2 = t2
          if t3 ~= 0 and t3 == t4 then
            r3 = t3 + 1
            gained = gained + (1 << r3)
          else
            r3, r4 = t3, t4
          end
        end
      end
      if r1 ~= a1 or r2 ~= a2 or r3 ~= a3 or r4 ~= a4 then
        b[p1], b[p2], b[p3], b[p4] = r1, r2, r3, r4
        changed = true
      end
    end
  end
  if not changed then return -1 end
  return gained
end

--- Returns (new board, gained, changed) without modifying b.
function M.move(b, dir)
  local nb = M.copy(b)
  local g = M.move_in_place(nb, dir)
  if g < 0 then return M.copy(b), 0, false end
  return nb, g, true
end

--- Whether dir changes the board.
function M.can_move(b, dir)
  local lines = LINES[dir]
  for l = 1, 4 do
    local idx = lines[l]
    local prev = b[idx[1]]
    for k = 2, 4 do
      local cur = b[idx[k]]
      if cur ~= 0 and (prev == 0 or prev == cur) then return true end
      prev = cur
    end
  end
  return false
end

--- Valid directions in canonical order.
function M.valid_moves(b)
  local out = {}
  for d = 0, 3 do
    if M.can_move(b, d) then out[#out + 1] = d end
  end
  return out
end

function M.is_over(b)
  for d = 0, 3 do
    if M.can_move(b, d) then return false end
  end
  return true
end

--- Spawn a tile (SPEC §5). Returns (index, exponent) with a 0-based index,
--- or nil if the board was full (no draws).
function M.spawn(b, rng)
  local n = 0
  for i = 1, 16 do
    if b[i] == 0 then n = n + 1 end
  end
  if n == 0 then return nil end
  local k = rng:below(n) -- position among the empties, ascending
  local pos = 0
  for i = 1, 16 do
    if b[i] == 0 then
      if k == 0 then
        pos = i
        break
      end
      k = k - 1
    end
  end
  local e = 1
  if rng:below(10) == 0 then e = 2 end
  b[pos] = e
  return pos - 1, e
end

--- Parse a direction: names ("left"), letters ("L") or digits ("2").
function M.parse_direction(s)
  local t = tostring(s):lower():match("^%s*(.-)%s*$")
  for i = 0, 3 do
    if t == M.NAMES[i] then return i end
  end
  if #t == 1 then
    local i = ("udlr"):find(t, 1, true)
    if i then return i - 1 end
    if t >= "0" and t <= "3" then return tonumber(t) end
  end
  return nil, string.format("invalid direction '%s'", tostring(s))
end

return M
