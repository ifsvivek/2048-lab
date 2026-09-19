-- SPEC §8: replay simulation and verification.
--
-- Failures are returned as `nil, err` where err is a ReplayError table
-- {code=, message=, moveIndex=} (moveIndex = -1 when not applicable).

local game = require("g2048.game")

local M = {}

M.INVALID_MOVE_AT = "INVALID_MOVE_AT"
M.BAD_LETTER = "BAD_LETTER"
M.SPEC_VERSION = "SPEC_VERSION"
M.FINAL_MISMATCH = "FINAL_MISMATCH"

local ReplayError = {}
ReplayError.__index = ReplayError
ReplayError.__tostring = function(e) return e.message end

local function rerr(code, message, index)
  return setmetatable({ code = code, message = message, moveIndex = index or -1 }, ReplayError)
end
M.error = rerr

function M.is_replay_error(e)
  return getmetatable(e) == ReplayError
end

local DIR = { U = 0, D = 1, L = 2, R = 3 }

--- Re-play moves from seed. Returns game or nil, ReplayError.
function M.simulate(seed, moves)
  local g = game.new(seed)
  for i = 1, #moves do
    local ch = moves:sub(i, i)
    local d = DIR[ch]
    if d == nil then
      return nil, rerr(M.BAD_LETTER, string.format("bad move letter '%s' at %d", ch, i - 1), i - 1)
    end
    if g:apply(d) == nil then
      return nil, rerr(M.INVALID_MOVE_AT, string.format("INVALID_MOVE_AT %d", i - 1), i - 1)
    end
  end
  return g
end

local function show(v)
  if type(v) == "string" then return v end
  return tostring(v)
end

--- Verify a replay. `final` may hold any of board/score/moveCount/historyHash
--- (nil fields are not checked). Returns snapshot or (snapshot|nil), ReplayError.
function M.verify(spec_version, seed, moves, final)
  if spec_version ~= game.SPEC_VERSION then
    return nil, rerr(M.SPEC_VERSION, string.format("unsupported specVersion %s", show(spec_version)))
  end
  local g, err = M.simulate(seed, moves)
  if not g then return nil, err end
  local snap = g:snapshot()
  if final then
    for _, key in ipairs({ "board", "score", "moveCount", "historyHash" }) do
      local claimed = final[key]
      if claimed ~= nil and claimed ~= snap[key] then
        return snap, rerr(M.FINAL_MISMATCH,
          string.format("final.%s mismatch: claimed %s, actual %s", key, show(claimed), show(snap[key])))
      end
    end
  end
  return snap
end

return M
