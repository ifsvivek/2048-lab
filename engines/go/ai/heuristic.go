package ai

import (
	"fmt"
	"sync"
)

// Weights are the integer heuristic weights (AI.md §2).
type Weights struct {
	Lost   int64 `json:"lost"`
	Empty  int64 `json:"empty"`
	Merges int64 `json:"merges"`
	Mono   int64 `json:"mono"`
	Sum    int64 `json:"sum"`
	Smooth int64 `json:"smooth"`
	Stable int64 `json:"stable"`
	Corner int64 `json:"corner"`
}

// HeuristicV1 is the canonical weight profile.
var HeuristicV1 = Weights{Lost: 200000, Empty: 270, Merges: 700, Mono: 47, Sum: 11}

// LineFeatures are the per-line heuristic features.
type LineFeatures struct {
	Empty  int64 `json:"empty"`
	Merges int64 `json:"merges"`
	Mono   int64 `json:"mono"`
	Sum    int64 `json:"sum"`
	Smooth int64 `json:"smooth"`
	Stable int64 `json:"stable"`
}

// Features computes the features of a 16-bit line value.
func Features(v uint16) LineFeatures {
	r := [4]int64{int64(v & 0xf), int64(v >> 4 & 0xf), int64(v >> 8 & 0xf), int64(v >> 12 & 0xf)}
	var f LineFeatures
	var prev, counter int64
	for _, rank := range r {
		f.Sum += rank * rank * rank
		if rank == 0 {
			f.Empty++
			continue
		}
		if prev == rank {
			counter++
		} else if counter > 0 {
			f.Merges += 1 + counter
			counter = 0
		}
		prev = rank
	}
	if counter > 0 {
		f.Merges += 1 + counter
	}
	var monoL, monoR int64
	for i := 1; i < 4; i++ {
		a := r[i-1] * r[i-1] * r[i-1] * r[i-1]
		b := r[i] * r[i] * r[i] * r[i]
		if r[i-1] > r[i] {
			monoL += a - b
		} else {
			monoR += b - a
		}
		if r[i-1] != 0 && r[i] != 0 {
			d := r[i-1] - r[i]
			if d < 0 {
				d = -d
			}
			f.Smooth += d
		}
	}
	if f.Empty == 0 && (monoL == 0 || monoR == 0) {
		f.Stable = 1
	}
	f.Mono = min(monoL, monoR)
	return f
}

// LineScore combines features with weights.
func LineScore(f LineFeatures, w Weights) int64 {
	return w.Lost + w.Empty*f.Empty + w.Merges*f.Merges - w.Mono*f.Mono - w.Sum*f.Sum - w.Smooth*f.Smooth + w.Stable*f.Stable
}

var (
	tableMu    sync.Mutex
	tableCache = map[Weights]*[65536]float64{}
)

// LineTable returns the (memoised) 65536-entry per-line score table.
func LineTable(w Weights) *[65536]float64 {
	tableMu.Lock()
	defer tableMu.Unlock()
	if t, ok := tableCache[w]; ok {
		return t
	}
	t := new([65536]float64)
	for v := 0; v < 65536; v++ {
		t[v] = float64(LineScore(Features(uint16(v)), w))
	}
	tableCache[w] = t
	return t
}

// CornerTerm is W.corner * maxRank if a corner holds the max rank, else 0.
func CornerTerm(b Bitboard, cornerWeight int64) float64 {
	if cornerWeight == 0 {
		return 0
	}
	var mx uint64
	for i := 0; i < 16; i++ {
		if n := b >> (4 * i) & 0xf; n > mx {
			mx = n
		}
	}
	if b&0xf == mx || b>>12&0xf == mx || b>>48&0xf == mx || b>>60 == mx {
		return float64(cornerWeight * int64(mx))
	}
	return 0
}

// Evaluate computes the heuristic value of a bitboard.
func Evaluate(b Bitboard, t *[65536]float64, cornerWeight int64) float64 {
	v := t[uint16(b)] + t[uint16(b>>16)] + t[uint16(b>>32)] + t[uint16(b>>48)] +
		t[Column(b, 0)] + t[Column(b, 1)] + t[Column(b, 2)] + t[Column(b, 3)]
	if cornerWeight != 0 {
		v += CornerTerm(b, cornerWeight)
	}
	return v
}

// Breakdown is the heuristic decomposition summed over all 8 lines.
type Breakdown struct {
	LineFeatures
	Corner float64 `json:"corner"`
	Total  float64 `json:"total"`
}

// HeuristicBreakdown decomposes the evaluation of b.
func HeuristicBreakdown(b Bitboard, w Weights) Breakdown {
	lines := [8]uint16{uint16(b), uint16(b >> 16), uint16(b >> 32), uint16(b >> 48), Column(b, 0), Column(b, 1), Column(b, 2), Column(b, 3)}
	var acc LineFeatures
	for _, v := range lines {
		f := Features(v)
		acc.Empty += f.Empty
		acc.Merges += f.Merges
		acc.Mono += f.Mono
		acc.Sum += f.Sum
		acc.Smooth += f.Smooth
		acc.Stable += f.Stable
	}
	return Breakdown{LineFeatures: acc, Corner: CornerTerm(b, w.Corner), Total: Evaluate(b, LineTable(w), w.Corner)}
}

// String formats weights for display.
func (w Weights) String() string {
	return fmt.Sprintf("lost=%d empty=%d merges=%d mono=%d sum=%d smooth=%d stable=%d corner=%d",
		w.Lost, w.Empty, w.Merges, w.Mono, w.Sum, w.Smooth, w.Stable, w.Corner)
}
