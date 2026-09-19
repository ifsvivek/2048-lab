// Package engine implements the canonical 2048 rules (spec/SPEC.md).
package engine

import "math/bits"

// RngState is the four-word xoshiro128** state.
type RngState [4]uint32

// Mix32 expands a seed into generator state (SPEC §4.1).
func Mix32(seed uint32) RngState {
	var s RngState
	x := seed
	for k := 0; k < 4; k++ {
		x += 0x9E3779B9
		z := x
		z = (z ^ (z >> 16)) * 0x85EBCA6B
		z = (z ^ (z >> 13)) * 0xC2B2AE35
		s[k] = z ^ (z >> 16)
	}
	if s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 {
		s[0] = 1
	}
	return s
}

// Rng is xoshiro128** (SPEC §4.2).
type Rng struct{ S RngState }

// NewRng creates a generator from explicit state.
func NewRng(s RngState) *Rng { return &Rng{S: s} }

// RngFromSeed creates a generator from a seed via Mix32.
func RngFromSeed(seed uint32) *Rng { return &Rng{S: Mix32(seed)} }

// Next returns the next 32-bit output.
func (r *Rng) Next() uint32 {
	s := &r.S
	result := bits.RotateLeft32(s[1]*5, 7) * 9
	t := s[1] << 9
	s[2] ^= s[0]
	s[3] ^= s[1]
	s[1] ^= s[2]
	s[0] ^= s[3]
	s[2] ^= t
	s[3] = bits.RotateLeft32(s[3], 11)
	return result
}

// Below returns an unbiased integer in [0, n), 1 <= n <= 2^32 (SPEC §4.3).
func (r *Rng) Below(n uint64) uint32 {
	const two32 = uint64(1) << 32
	limit := two32 - two32%n
	for {
		x := uint64(r.Next())
		if x < limit {
			return uint32(x % n)
		}
	}
}

// State returns a copy of the generator state.
func (r *Rng) State() RngState { return r.S }
