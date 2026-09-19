package engine

import "fmt"

const (
	fnvOffset uint32 = 0x811C9DC5
	fnvPrime  uint32 = 0x01000193
)

// Fnv1a32 hashes bytes (SPEC §7).
func Fnv1a32(data []byte) uint32 {
	h := fnvOffset
	for _, c := range data {
		h = (h ^ uint32(c)) * fnvPrime
	}
	return h
}

// BoardHash is fnv1a32 over the 16 exponent bytes.
func BoardHash(b *Board) uint32 {
	h := fnvOffset
	for _, c := range b {
		h = (h ^ uint32(c)) * fnvPrime
	}
	return h
}

// HistoryStep computes fnv1a32(le32(h) ++ board ++ [dir]).
func HistoryStep(h uint32, b *Board, dir int) uint32 {
	x := fnvOffset
	for k := 0; k < 4; k++ {
		x = (x ^ ((h >> (8 * k)) & 0xff)) * fnvPrime
	}
	for _, c := range b {
		x = (x ^ uint32(c)) * fnvPrime
	}
	return (x ^ uint32(dir)) * fnvPrime
}

// HashHex formats a hash as 8 lowercase hex digits.
func HashHex(h uint32) string { return fmt.Sprintf("%08x", h) }
