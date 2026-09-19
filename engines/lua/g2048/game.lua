-- SPEC §6: game lifecycle.

local board = require("g2048.board")
local rng = require("g2048.rng")
local hash = require("g2048.hash")

local M = {}

M.SPEC_VERSION = 1
M.ENGINE_VERSION = "1.0.0"

local LETTERS = {}
for d = 0, 3 do LETTERS[d] = board.LETTERS:sub(d + 1, d + 1) end

local Game = {}
Game.__index = Game
M.Game = Game

--- New game: two initial spawns.
function M.new(seed)
  seed = seed & 0xffffffff
  local g = setmetatable({
    seed = seed,
    board = board.empty(),
    score = 0,
    move_count = 0,
    rng = rng.from_seed(seed),
    hash = 0,
    moves = {},
  }, Game)
  board.spawn(g.board, g.rng)
  board.spawn(g.board, g.rng)
  g.hash = hash.board_hash(g.board)
  return g
end

--- Apply a move. Returns the score gained, or nil if invalid (no state change).
function Game:apply(dir)
  local b = self.board
  local gained = board.move_in_place(b, dir)
  if gained < 0 then return nil end
  self.score = self.score + gained
  local n = self.move_count + 1
  self.move_count = n
  board.spawn(b, self.rng)
  self.hash = hash.history_step(self.hash, b, dir)
  self.moves[n] = LETTERS[dir]
  return gained
end

function Game:over()
  return board.is_over(self.board)
end

function Game:history_hash()
  return hash.hex(self.hash)
end

function Game:moves_string()
  return table.concat(self.moves)
end

--- Snapshot table (plain fields).
function Game:snapshot()
  return {
    seed = self.seed,
    board = board.to_hex(self.board),
    score = self.score,
    moveCount = self.move_count,
    maxTile = board.max_tile(self.board),
    over = self:over(),
    historyHash = self:history_hash(),
  }
end

return M
