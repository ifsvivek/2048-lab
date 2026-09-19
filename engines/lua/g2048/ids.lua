-- SPEC §9: seeds, ULIDs and replay codes.
--
-- Random bytes come from /dev/urandom when available; otherwise math.random
-- (not a CSPRNG) is used as a fallback.

local M = {}

M.REPLAY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
local CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

local function random_bytes(n)
  local f = io.open("/dev/urandom", "rb")
  if f then
    local s = f:read(n)
    f:close()
    if s and #s == n then return s end
  end
  local t = {}
  for i = 1, n do t[i] = string.char(math.random(0, 255)) end
  return table.concat(t)
end
M.random_bytes = random_bytes

--- uint32 seed from a CSPRNG.
function M.random_seed()
  return (string.unpack("<I4", random_bytes(4)))
end

--- Current Unix time in milliseconds (1 s resolution from os.time, refined
--- with `date +%s%3N` when available).
function M.now_ms()
  local p = io.popen("date +%s%3N 2>/dev/null")
  if p then
    local s = p:read("l")
    p:close()
    local v = s and math.tointeger(tonumber(s))
    if v and v > 1e12 then return v end
  end
  return os.time() * 1000
end

--- A new ULID (26 chars, Crockford base32). `ms` defaults to now.
function M.ulid(ms)
  local t = ms or M.now_ms()
  local out = {}
  for i = 10, 1, -1 do
    local r = t % 32
    out[i] = CROCKFORD:sub(r + 1, r + 1)
    t = t // 32
  end
  local rnd = random_bytes(16)
  for i = 1, 16 do
    local v = rnd:byte(i) & 31
    out[10 + i] = CROCKFORD:sub(v + 1, v + 1)
  end
  return table.concat(out)
end

function M.is_ulid(s)
  if type(s) ~= "string" or #s ~= 26 then return false end
  for i = 1, 26 do
    if not CROCKFORD:find(s:sub(i, i), 1, true) then return false end
  end
  return true
end

--- XXXX-XXXX-XXXX
function M.format_replay_code(n)
  return n:sub(1, 4) .. "-" .. n:sub(5, 8) .. "-" .. n:sub(9, 12)
end

--- Upper-case, strip non [A-Z0-9], validate. Returns normalized or nil.
function M.normalize_replay_code(input)
  local s = input:upper():gsub("[^A-Z0-9]", "")
  if #s ~= 12 then return nil end
  for i = 1, 12 do
    if not M.REPLAY_ALPHABET:find(s:sub(i, i), 1, true) then return nil end
  end
  return s
end

--- A new formatted replay code.
function M.generate_replay_code()
  local rnd = random_bytes(12)
  local s = {}
  for i = 1, 12 do
    local v = rnd:byte(i) & 31
    s[i] = M.REPLAY_ALPHABET:sub(v + 1, v + 1)
  end
  return M.format_replay_code(table.concat(s))
end

return M
