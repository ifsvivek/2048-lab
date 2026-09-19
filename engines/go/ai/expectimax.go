package ai

import (
	"encoding/json"
	"fmt"
	"math"
	"time"
)

// Config is the expectimax configuration (AI.md §3).
type Config struct {
	// AutoDepth selects depth = clamp(distinct-2, MinDepth, MaxDepth); otherwise Depth is fixed.
	AutoDepth        bool
	Depth            int
	MinDepth         int
	MaxDepth         int
	FourPruneEmpties int
	// TimeBudgetMs > 0 enables iterative deepening (non-deterministic).
	TimeBudgetMs float64
	// TTBits is log2 of the transposition-table slot count.
	TTBits  int
	Weights Weights
}

// CanonicalConfig returns the canonical profile.
func CanonicalConfig() Config {
	return Config{AutoDepth: true, MinDepth: 2, MaxDepth: 4, TTBits: 20, Weights: HeuristicV1}
}

// MarshalJSON renders depth as "auto" or an integer, matching the TS descriptor.
func (c Config) MarshalJSON() ([]byte, error) {
	var depth any = c.Depth
	if c.AutoDepth {
		depth = "auto"
	}
	return json.Marshal(struct {
		Depth            any     `json:"depth"`
		MinDepth         int     `json:"minDepth"`
		MaxDepth         int     `json:"maxDepth"`
		FourPruneEmpties int     `json:"fourPruneEmpties"`
		TimeBudgetMs     float64 `json:"timeBudgetMs"`
		TTBits           int     `json:"ttBits"`
		Weights          Weights `json:"weights"`
	}{depth, c.MinDepth, c.MaxDepth, c.FourPruneEmpties, c.TimeBudgetMs, c.TTBits, c.Weights})
}

func asInt(key string, v any) (int64, error) {
	f, ok := v.(float64)
	if !ok {
		if i, ok2 := v.(int); ok2 {
			return int64(i), nil
		}
		return 0, fmt.Errorf("config %s must be a number", key)
	}
	if f != math.Trunc(f) || math.IsInf(f, 0) {
		return 0, fmt.Errorf("config %s must be an integer (got %v)", key, f)
	}
	return int64(f), nil
}

// ParseConfig overlays a JSON-decoded config object onto the canonical profile.
func ParseConfig(m map[string]any) (Config, error) {
	c := CanonicalConfig()
	for k, v := range m {
		var err error
		var n int64
		switch k {
		case "depth":
			if s, ok := v.(string); ok {
				if s != "auto" {
					return c, fmt.Errorf("config depth must be an integer or \"auto\"")
				}
				c.AutoDepth = true
			} else {
				n, err = asInt(k, v)
				c.AutoDepth, c.Depth = false, int(n)
				if err == nil && n < 1 {
					err = fmt.Errorf("config depth must be >= 1")
				}
			}
		case "minDepth":
			n, err = asInt(k, v)
			c.MinDepth = int(n)
		case "maxDepth":
			n, err = asInt(k, v)
			c.MaxDepth = int(n)
		case "fourPruneEmpties":
			n, err = asInt(k, v)
			c.FourPruneEmpties = int(n)
		case "timeBudgetMs":
			f, ok := v.(float64)
			if !ok {
				err = fmt.Errorf("config timeBudgetMs must be a number")
			}
			c.TimeBudgetMs = f
		case "ttBits":
			n, err = asInt(k, v)
			if err == nil && (n < 4 || n > 28) {
				err = fmt.Errorf("config ttBits out of range")
			}
			c.TTBits = int(n)
		case "weights":
			wm, ok := v.(map[string]any)
			if !ok {
				return c, fmt.Errorf("config weights must be an object")
			}
			for wk, wv := range wm {
				n, err := asInt("weights."+wk, wv)
				if err != nil {
					return c, fmt.Errorf("heuristic weight '%s' must be an integer (got %v)", wk, wv)
				}
				switch wk {
				case "lost":
					c.Weights.Lost = n
				case "empty":
					c.Weights.Empty = n
				case "merges":
					c.Weights.Merges = n
				case "mono":
					c.Weights.Mono = n
				case "sum":
					c.Weights.Sum = n
				case "smooth":
					c.Weights.Smooth = n
				case "stable":
					c.Weights.Stable = n
				case "corner":
					c.Weights.Corner = n
				}
			}
		}
		if err != nil {
			return c, err
		}
	}
	return c, nil
}

// SearchResult is the outcome of one search.
type SearchResult struct {
	Move            int // -1 if no valid move
	Value           float64
	Values          [4]*float64
	Depth           int
	Nodes           int64
	TTHits          int64
	TTSize          int
	TimeUs          int64
	Deterministic   bool
	CompletedDepths []int
}

// transposition table: exact key (board, depth). Mirrors the TS reference
// (hash, 4-slot linear probe, store policy, clear at 75%) so that node and
// hit counts are comparable across ports.
type ttable struct {
	mask  uint32
	board []uint64
	depth []uint8
	value []float64
	size  int
}

func newTT(bits int) *ttable {
	n := 1 << bits
	return &ttable{mask: uint32(n - 1), board: make([]uint64, n), depth: make([]uint8, n), value: make([]float64, n)}
}

func (t *ttable) slot(b uint64, d int) uint32 {
	lo, hi := uint32(b), uint32(b>>32)
	h := ((lo ^ uint32(d)*0x9e3779b1) * 0x85ebca6b) ^ (hi * 0xc2b2ae35)
	h ^= h >> 15
	h *= 0x2c1b3c6d
	h ^= h >> 12
	return h & t.mask
}

func (t *ttable) clear() {
	clear(t.depth)
	t.size = 0
}

// Search is a reusable expectimax searcher (not safe for concurrent use).
type Search struct {
	Config   Config
	table    *[65536]float64
	corner   int64
	tt       *ttable
	nodes    int64
	ttHits   int64
	deadline time.Time
	timed    bool
	aborted  bool
}

// NewSearch creates a searcher with a preallocated transposition table.
func NewSearch(c Config) *Search {
	if c.TTBits == 0 {
		c.TTBits = 20
	}
	return &Search{Config: c, table: LineTable(c.Weights), corner: c.Weights.Corner, tt: newTT(c.TTBits)}
}

// Evaluate is the heuristic under this searcher's weights.
func (s *Search) Evaluate(b Bitboard) float64 { return Evaluate(b, s.table, s.corner) }

// DepthFor returns the search depth for b.
func (s *Search) DepthFor(b Bitboard) int {
	c := &s.Config
	if !c.AutoDepth {
		return c.Depth
	}
	return max(c.MinDepth, min(c.MaxDepth, DistinctRanks(b)-2))
}

func (s *Search) maxnode(b Bitboard, d int) float64 {
	s.nodes++
	if d == 0 {
		return Evaluate(b, s.table, s.corner)
	}
	best := 0.0
	for dir := 0; dir < 4; dir++ {
		nb, ok := Move(b, dir)
		if !ok {
			continue
		}
		v := s.chance(nb, d)
		if s.aborted {
			return 0
		}
		if v > best {
			best = v
		}
	}
	return best
}

func (s *Search) chance(b Bitboard, d int) float64 {
	s.nodes++
	if s.timed && s.nodes&0xfff == 0 && time.Now().After(s.deadline) {
		s.aborted = true
		return 0
	}
	tt := s.tt
	home := tt.slot(b, d)
	sl := home
	for probe := 0; probe < 4; probe++ {
		sd := tt.depth[sl]
		if sd == 0 {
			break
		}
		if int(sd) == d && tt.board[sl] == b {
			s.ttHits++
			return tt.value[sl]
		}
		sl = (sl + 1) & tt.mask
	}

	n := 0
	for i := 0; i < 16; i++ {
		if b>>(4*i)&0xf == 0 {
			n++
		}
	}
	p := s.Config.FourPruneEmpties
	four := !(p > 0 && n >= p)
	sum := 0.0
	for i := 0; i < 16; i++ {
		sh := uint(4 * i)
		if b>>sh&0xf != 0 {
			continue
		}
		if four {
			v2 := s.maxnode(b|1<<sh, d-1)
			if s.aborted {
				return 0
			}
			sum = sum + float64(0.9*v2)
			v4 := s.maxnode(b|2<<sh, d-1)
			if s.aborted {
				return 0
			}
			sum = sum + float64(0.1*v4)
		} else {
			v2 := s.maxnode(b|1<<sh, d-1)
			if s.aborted {
				return 0
			}
			sum = sum + v2
		}
	}
	v := sum / float64(n)

	target := home
	sl = home
	for probe := 0; probe < 4; probe++ {
		if tt.depth[sl] == 0 {
			target = sl
			tt.size++
			break
		}
		sl = (sl + 1) & tt.mask
	}
	tt.board[target] = b
	tt.depth[target] = uint8(d)
	tt.value[target] = v
	return v
}

type rootResult struct {
	move   int
	value  float64
	values [4]*float64
}

func (s *Search) root(b Bitboard, depth int) (rootResult, bool) {
	r := rootResult{move: -1, value: math.Inf(-1)}
	for dir := 0; dir < 4; dir++ {
		nb, ok := Move(b, dir)
		if !ok {
			continue
		}
		v := s.chance(nb, depth)
		if s.aborted {
			return r, false
		}
		vv := v
		r.values[dir] = &vv
		if v > r.value {
			r.value, r.move = v, dir
		}
	}
	return r, true
}

// Run searches b and returns the decision.
func (s *Search) Run(b Bitboard) SearchResult {
	start := time.Now()
	s.nodes, s.ttHits = 0, 0
	s.aborted, s.timed = false, false
	if float64(s.tt.size) > float64(s.tt.mask+1)*0.75 {
		s.tt.clear()
	}
	if s.Config.TimeBudgetMs <= 0 {
		depth := s.DepthFor(b)
		r, _ := s.root(b, depth)
		return s.result(r, depth, start, true, []int{depth})
	}
	best, _ := s.root(b, 1)
	depth := 1
	completed := []int{1}
	s.timed = true
	s.deadline = start.Add(time.Duration(s.Config.TimeBudgetMs * float64(time.Millisecond)))
	for d := 2; d <= s.Config.MaxDepth; d++ {
		r, ok := s.root(b, d)
		if !ok {
			break
		}
		best, depth = r, d
		completed = append(completed, d)
	}
	s.timed, s.aborted = false, false
	return s.result(best, depth, start, false, completed)
}

func (s *Search) result(r rootResult, depth int, start time.Time, det bool, completed []int) SearchResult {
	return SearchResult{
		Move: r.move, Value: r.value, Values: r.values, Depth: depth,
		Nodes: s.nodes, TTHits: s.ttHits, TTSize: s.tt.size,
		TimeUs:        roundUs(time.Since(start)),
		Deterministic: det, CompletedDepths: completed,
	}
}

func roundUs(d time.Duration) int64 { return int64(math.Round(float64(d.Nanoseconds()) / 1000)) }
