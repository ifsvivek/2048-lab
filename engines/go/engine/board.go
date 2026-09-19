package engine

import (
	"fmt"
	"strings"
)

// Board holds 16 exponents, row-major (SPEC §1).
type Board [16]uint8

// Directions (SPEC §2).
const (
	Up    = 0
	Down  = 1
	Left  = 2
	Right = 3
)

// DirectionLetters maps direction index to its replay letter.
const DirectionLetters = "UDLR"

// DirectionNames maps direction index to its name.
var DirectionNames = [4]string{"up", "down", "left", "right"}

// Lines[dir][line] = cell indices starting at the edge tiles slide toward (SPEC §3).
var Lines [4][4][4]int

func init() {
	for k := 0; k < 4; k++ {
		for j := 0; j < 4; j++ {
			Lines[Up][k][j] = j*4 + k
			Lines[Down][k][j] = (3-j)*4 + k
			Lines[Left][k][j] = k*4 + j
			Lines[Right][k][j] = k*4 + 3 - j
		}
	}
}

const hexDigits = "0123456789abcdefghijklmnopqrstuvwxyz"

// Hex returns the canonical boardHex encoding.
func (b *Board) Hex() string {
	var s [16]byte
	for i, e := range b {
		s[i] = hexDigits[e]
	}
	return string(s[:])
}

// BoardFromHex decodes a boardHex string.
func BoardFromHex(hex string) (Board, error) {
	var b Board
	if len(hex) != 16 {
		return b, fmt.Errorf("boardHex must be 16 chars, got %d", len(hex))
	}
	for i := 0; i < 16; i++ {
		v := strings.IndexByte(hexDigits, lower(hex[i]))
		if v < 0 {
			return b, fmt.Errorf("invalid boardHex character '%c'", hex[i])
		}
		b[i] = uint8(v)
	}
	return b, nil
}

func lower(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 32
	}
	return c
}

// MustBoard decodes boardHex and panics on error (tests/fixtures).
func MustBoard(hex string) Board {
	b, err := BoardFromHex(hex)
	if err != nil {
		panic(err)
	}
	return b
}

// Matrix returns tile values as board[row][col].
func (b *Board) Matrix() [][]int64 {
	m := make([][]int64, 4)
	for r := 0; r < 4; r++ {
		m[r] = make([]int64, 4)
		for c := 0; c < 4; c++ {
			if e := b[r*4+c]; e != 0 {
				m[r][c] = int64(1) << e
			}
		}
	}
	return m
}

// BoardFromMatrix converts tile values (0 = empty, powers of two) to a board.
func BoardFromMatrix(m [][]int64) (Board, error) {
	var b Board
	if len(m) != 4 {
		return b, fmt.Errorf("board must have 4 rows")
	}
	for r := 0; r < 4; r++ {
		if len(m[r]) != 4 {
			return b, fmt.Errorf("board row %d must have 4 cells", r)
		}
		for c := 0; c < 4; c++ {
			v := m[r][c]
			if v == 0 {
				continue
			}
			if v < 2 || v&(v-1) != 0 {
				return b, fmt.Errorf("invalid tile value %d", v)
			}
			e := 0
			for v > 1 {
				v >>= 1
				e++
			}
			if e > 35 {
				return b, fmt.Errorf("tile too large")
			}
			b[r*4+c] = uint8(e)
		}
	}
	return b, nil
}

// MaxExponent returns the largest exponent on the board.
func (b *Board) MaxExponent() uint8 {
	var m uint8
	for _, e := range b {
		if e > m {
			m = e
		}
	}
	return m
}

// MaxTile returns the largest tile value (0 for an empty board).
func (b *Board) MaxTile() int64 {
	e := b.MaxExponent()
	if e == 0 {
		return 0
	}
	return int64(1) << e
}

// MoveInPlace applies dir. Returns the score gained, or -1 if the move is
// invalid (board untouched).
func (b *Board) MoveInPlace(dir int) int64 {
	var gained int64
	changed := false
	for l := 0; l < 4; l++ {
		idx := &Lines[dir][l]
		var tiles [4]uint8
		n := 0
		for k := 0; k < 4; k++ {
			if v := b[idx[k]]; v != 0 {
				tiles[n] = v
				n++
			}
		}
		var res [4]uint8
		out := 0
		for i := 0; i < n; {
			if i+1 < n && tiles[i] == tiles[i+1] {
				e := tiles[i] + 1
				res[out] = e
				gained += int64(1) << e
				i += 2
			} else {
				res[out] = tiles[i]
				i++
			}
			out++
		}
		for k := 0; k < 4; k++ {
			if b[idx[k]] != res[k] {
				b[idx[k]] = res[k]
				changed = true
			}
		}
	}
	if !changed {
		return -1
	}
	return gained
}

// Move returns the moved board, the score gained and whether it changed.
func (b Board) Move(dir int) (Board, int64, bool) {
	nb := b
	g := nb.MoveInPlace(dir)
	if g < 0 {
		return b, 0, false
	}
	return nb, g, true
}

// CanMove reports whether dir changes the board.
func (b *Board) CanMove(dir int) bool {
	for l := 0; l < 4; l++ {
		idx := &Lines[dir][l]
		for k := 1; k < 4; k++ {
			prev, cur := b[idx[k-1]], b[idx[k]]
			if cur != 0 && (prev == 0 || prev == cur) {
				return true
			}
		}
	}
	return false
}

// ValidMoves returns the valid directions in canonical order.
func (b *Board) ValidMoves() []int {
	var out []int
	for d := 0; d < 4; d++ {
		if b.CanMove(d) {
			out = append(out, d)
		}
	}
	return out
}

// IsOver reports whether no move is valid.
func (b *Board) IsOver() bool {
	for d := 0; d < 4; d++ {
		if b.CanMove(d) {
			return false
		}
	}
	return true
}

// Spawn places a tile per SPEC §5. Returns (index, exponent, true), or
// ok=false if the board was full (no draws).
func (b *Board) Spawn(r *Rng) (index int, exponent uint8, ok bool) {
	var empties [16]int
	n := 0
	for i, e := range b {
		if e == 0 {
			empties[n] = i
			n++
		}
	}
	if n == 0 {
		return 0, 0, false
	}
	index = empties[r.Below(uint64(n))]
	exponent = 1
	if r.Below(10) == 0 {
		exponent = 2
	}
	b[index] = exponent
	return index, exponent, true
}

// ParseDirection accepts names ("left"), letters ("L") or digits ("2").
func ParseDirection(s string) (int, error) {
	t := strings.ToLower(strings.TrimSpace(s))
	for i, n := range DirectionNames {
		if t == n {
			return i, nil
		}
	}
	if len(t) == 1 {
		if i := strings.IndexByte("udlr", t[0]); i >= 0 {
			return i, nil
		}
		if t[0] >= '0' && t[0] <= '3' {
			return int(t[0] - '0'), nil
		}
	}
	return -1, fmt.Errorf("invalid direction '%s'", s)
}
