package engine

import (
	"fmt"
	"strings"
)

// Replay error codes (SPEC §8).
const (
	ErrInvalidMoveAt = "INVALID_MOVE_AT"
	ErrBadLetter     = "BAD_LETTER"
	ErrSpecVersion   = "SPEC_VERSION"
	ErrFinalMismatch = "FINAL_MISMATCH"
)

// ReplayError is a replay verification failure. MoveIndex is -1 when not applicable.
type ReplayError struct {
	Code      string
	Message   string
	MoveIndex int
}

func (e *ReplayError) Error() string { return e.Message }

// LetterToDirection maps a replay letter to a direction.
func LetterToDirection(ch byte, at int) (int, error) {
	d := strings.IndexByte(DirectionLetters, ch)
	if d < 0 {
		return -1, &ReplayError{Code: ErrBadLetter, Message: fmt.Sprintf("bad move letter '%c' at %d", ch, at), MoveIndex: at}
	}
	return d, nil
}

// Simulate re-plays moves from seed.
func Simulate(seed uint32, moves string) (*Game, error) {
	g := NewGame(seed)
	for i := 0; i < len(moves); i++ {
		d, err := LetterToDirection(moves[i], i)
		if err != nil {
			return nil, err
		}
		if _, ok := g.Apply(d); !ok {
			return nil, &ReplayError{Code: ErrInvalidMoveAt, Message: fmt.Sprintf("INVALID_MOVE_AT %d", i), MoveIndex: i}
		}
	}
	return g, nil
}

// FinalClaim holds client-claimed final values; nil fields are not checked.
type FinalClaim struct {
	Board       *string `json:"board,omitempty"`
	Score       *int64  `json:"score,omitempty"`
	MoveCount   *int    `json:"moveCount,omitempty"`
	HistoryHash *string `json:"historyHash,omitempty"`
}

// VerifyReplay re-simulates a replay and returns the authoritative snapshot.
func VerifyReplay(specVersion int, seed uint32, moves string, final *FinalClaim) (Snapshot, error) {
	if specVersion != SpecVersion {
		return Snapshot{}, &ReplayError{Code: ErrSpecVersion, Message: fmt.Sprintf("unsupported specVersion %d", specVersion), MoveIndex: -1}
	}
	g, err := Simulate(seed, moves)
	if err != nil {
		return Snapshot{}, err
	}
	snap := g.Snapshot()
	if final != nil {
		mismatch := func(key string, claimed, actual any) error {
			return &ReplayError{Code: ErrFinalMismatch, Message: fmt.Sprintf("final.%s mismatch: claimed %v, actual %v", key, claimed, actual), MoveIndex: -1}
		}
		if final.Board != nil && *final.Board != snap.Board {
			return snap, mismatch("board", *final.Board, snap.Board)
		}
		if final.Score != nil && *final.Score != snap.Score {
			return snap, mismatch("score", *final.Score, snap.Score)
		}
		if final.MoveCount != nil && *final.MoveCount != snap.MoveCount {
			return snap, mismatch("moveCount", *final.MoveCount, snap.MoveCount)
		}
		if final.HistoryHash != nil && *final.HistoryHash != snap.HistoryHash {
			return snap, mismatch("historyHash", *final.HistoryHash, snap.HistoryHash)
		}
	}
	return snap, nil
}
