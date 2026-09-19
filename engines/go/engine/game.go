package engine

// SpecVersion is the implemented spec version.
const SpecVersion = 1

// EngineVersion is this port's engine version.
const EngineVersion = "1.0.0"

// Snapshot is the serialisable game state.
type Snapshot struct {
	Seed        uint32 `json:"seed"`
	Board       string `json:"board"`
	Score       int64  `json:"score"`
	MoveCount   int    `json:"moveCount"`
	MaxTile     int64  `json:"maxTile"`
	Over        bool   `json:"over"`
	HistoryHash string `json:"historyHash"`
}

// Game is the SPEC §6 lifecycle.
type Game struct {
	Seed      uint32
	Board     Board
	Score     int64
	MoveCount int
	Rng       Rng
	Hash      uint32
	moves     []byte
}

// NewGame creates a game and spawns the two initial tiles.
func NewGame(seed uint32) *Game {
	g := &Game{Seed: seed, Rng: Rng{S: Mix32(seed)}}
	g.Board.Spawn(&g.Rng)
	g.Board.Spawn(&g.Rng)
	g.Hash = BoardHash(&g.Board)
	return g
}

// Apply applies a move; returns (gained, true) or (0, false) if invalid (no state change).
func (g *Game) Apply(dir int) (int64, bool) {
	gained := g.Board.MoveInPlace(dir)
	if gained < 0 {
		return 0, false
	}
	g.Score += gained
	g.MoveCount++
	g.Board.Spawn(&g.Rng)
	g.Hash = HistoryStep(g.Hash, &g.Board, dir)
	g.moves = append(g.moves, DirectionLetters[dir])
	return gained, true
}

// Over reports whether the game has ended.
func (g *Game) Over() bool { return g.Board.IsOver() }

// HistoryHash returns the running history hash as hex.
func (g *Game) HistoryHash() string { return HashHex(g.Hash) }

// Moves returns the move letters played so far.
func (g *Game) Moves() string { return string(g.moves) }

// Snapshot returns the current state.
func (g *Game) Snapshot() Snapshot {
	return Snapshot{
		Seed:        g.Seed,
		Board:       g.Board.Hex(),
		Score:       g.Score,
		MoveCount:   g.MoveCount,
		MaxTile:     g.Board.MaxTile(),
		Over:        g.Over(),
		HistoryHash: g.HistoryHash(),
	}
}
