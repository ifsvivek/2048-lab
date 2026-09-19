// Package ai implements the canonical expectimax agent (spec/AI.md) and the
// reference random / greedy agents.
package ai

import "g2048/engine"

// Bitboard: cell i occupies bits 4i..4i+3 (AI.md §1).
type Bitboard = uint64

var (
	// lineTowardLow slides toward the low nibble ("left" for rows, "up" for columns).
	lineTowardLow [65536]uint16
	// lineTowardHigh slides toward the high nibble ("right" / "down").
	lineTowardHigh [65536]uint16
	// spreadCol places a line value as column 0 (nibble k -> row k).
	spreadCol [65536]uint64
)

func reverseLine(v uint16) uint16 {
	return (v&0xf)<<12 | ((v>>4)&0xf)<<8 | ((v>>8)&0xf)<<4 | (v>>12)&0xf
}

func init() {
	for v := 0; v < 65536; v++ {
		var r [4]uint16
		for k := 0; k < 4; k++ {
			r[k] = uint16(v>>(4*k)) & 0xf
		}
		var tiles [4]uint16
		n := 0
		for _, x := range r {
			if x != 0 {
				tiles[n] = x
				n++
			}
		}
		var out [4]uint16
		o := 0
		for i := 0; i < n; i++ {
			if i+1 < n && tiles[i] == tiles[i+1] {
				out[o] = min(tiles[i]+1, 15)
				i++
			} else {
				out[o] = tiles[i]
			}
			o++
		}
		lineTowardLow[v] = out[0] | out[1]<<4 | out[2]<<8 | out[3]<<12
		spreadCol[v] = uint64(r[0]) | uint64(r[1])<<16 | uint64(r[2])<<32 | uint64(r[3])<<48
	}
	for v := 0; v < 65536; v++ {
		lineTowardHigh[v] = reverseLine(lineTowardLow[reverseLine(uint16(v))])
	}
}

// Column extracts column c as a line value (row 0 in the lowest nibble).
func Column(b Bitboard, c int) uint16 {
	x := b >> (4 * c)
	return uint16(x&0xf | (x>>16&0xf)<<4 | (x>>32&0xf)<<8 | (x>>48&0xf)<<12)
}

// Move applies dir to a bitboard (saturating at rank 15). Returns the new
// board and whether it changed.
func Move(b Bitboard, dir int) (Bitboard, bool) {
	var nb Bitboard
	switch dir {
	case engine.Left, engine.Right:
		t := &lineTowardLow
		if dir == engine.Right {
			t = &lineTowardHigh
		}
		nb = uint64(t[uint16(b)]) | uint64(t[uint16(b>>16)])<<16 | uint64(t[uint16(b>>32)])<<32 | uint64(t[uint16(b>>48)])<<48
	default:
		t := &lineTowardLow
		if dir == engine.Down {
			t = &lineTowardHigh
		}
		nb = spreadCol[t[Column(b, 0)]] | spreadCol[t[Column(b, 1)]]<<4 | spreadCol[t[Column(b, 2)]]<<8 | spreadCol[t[Column(b, 3)]]<<12
	}
	return nb, nb != b
}

// FromBoard converts a game board, clamping exponents above 15.
func FromBoard(board *engine.Board) Bitboard {
	var b Bitboard
	for i, e := range board {
		b |= uint64(min(e, 15)) << (4 * i)
	}
	return b
}

// ToBoard converts a bitboard back to a game board.
func ToBoard(b Bitboard) engine.Board {
	var out engine.Board
	for i := 0; i < 16; i++ {
		out[i] = uint8(b>>(4*i)) & 0xf
	}
	return out
}

// DistinctRanks counts distinct non-zero ranks.
func DistinctRanks(b Bitboard) int {
	var mask uint32
	for i := 0; i < 16; i++ {
		mask |= 1 << ((b >> (4 * i)) & 0xf)
	}
	mask &^= 1
	n := 0
	for mask != 0 {
		mask &= mask - 1
		n++
	}
	return n
}
