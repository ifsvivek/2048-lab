package ai

import (
	"fmt"
	"time"

	"g2048/engine"
)

// Metrics are per-decision metrics (AI.md §4).
type Metrics struct {
	Depth           *int       `json:"depth,omitempty"`
	Nodes           *int64     `json:"nodes,omitempty"`
	TTHits          *int64     `json:"ttHits,omitempty"`
	TTSize          *int       `json:"ttSize,omitempty"`
	TimeUs          int64      `json:"timeUs"`
	Values          []*float64 `json:"values,omitempty"`
	Heuristic       *Breakdown `json:"heuristic,omitempty"`
	Deterministic   bool       `json:"deterministic"`
	CompletedDepths []int      `json:"completedDepths,omitempty"`
}

// Decision is an agent's chosen move plus metrics.
type Decision struct {
	Move    int
	Metrics Metrics
}

// Agent is the common agent contract.
type Agent interface {
	ID() string
	// Reset is called once per game before the first decision.
	Reset(seed uint32)
	// Decide returns a valid move; only called when at least one move is valid.
	Decide(board *engine.Board) Decision
	// ConfigJSON is the effective configuration (nil if none).
	ConfigJSON() any
}

// RandomAgent is the SPEC §10 reference random agent.
type RandomAgent struct{ rng engine.Rng }

func NewRandomAgent() *RandomAgent { return &RandomAgent{rng: *engine.RngFromSeed(0)} }

func (a *RandomAgent) ID() string        { return "random" }
func (a *RandomAgent) ConfigJSON() any   { return nil }
func (a *RandomAgent) Reset(seed uint32) { a.rng = *engine.RngFromSeed(seed ^ 0xA5A5A5A5) }

func (a *RandomAgent) Decide(board *engine.Board) Decision {
	t := time.Now()
	var valid [4]int
	n := 0
	for d := 0; d < 4; d++ {
		if board.CanMove(d) {
			valid[n] = d
			n++
		}
	}
	mv := valid[a.rng.Below(uint64(n))]
	return Decision{Move: mv, Metrics: Metrics{TimeUs: roundUs(time.Since(t)), Deterministic: true}}
}

// GreedyAgent maximises empty cells after the move; ties go to the lower direction.
type GreedyAgent struct{}

func (GreedyAgent) ID() string      { return "greedy" }
func (GreedyAgent) ConfigJSON() any { return nil }
func (GreedyAgent) Reset(uint32)    {}

func (GreedyAgent) Decide(board *engine.Board) Decision {
	t := time.Now()
	b := FromBoard(board)
	best := -1
	if v := board.ValidMoves(); len(v) > 0 {
		best = v[0]
	}
	bestScore := -1
	for d := 0; d < 4; d++ {
		nb, ok := Move(b, d)
		if !ok {
			continue
		}
		empty := 0
		for i := 0; i < 16; i++ {
			if nb>>(4*i)&0xf == 0 {
				empty++
			}
		}
		if empty > bestScore {
			bestScore, best = empty, d
		}
	}
	return Decision{Move: best, Metrics: Metrics{TimeUs: roundUs(time.Since(t)), Deterministic: true}}
}

// ExpectimaxAgent wraps Search.
type ExpectimaxAgent struct {
	S          *Search
	LastResult SearchResult
}

func NewExpectimaxAgent(c Config) *ExpectimaxAgent { return &ExpectimaxAgent{S: NewSearch(c)} }

func (a *ExpectimaxAgent) ID() string      { return "expectimax" }
func (a *ExpectimaxAgent) ConfigJSON() any { return a.S.Config }
func (a *ExpectimaxAgent) Reset(uint32)    {}

func (a *ExpectimaxAgent) Decide(board *engine.Board) Decision {
	b := FromBoard(board)
	r := a.S.Run(b)
	a.LastResult = r
	mv := r.Move
	if mv < 0 {
		if v := board.ValidMoves(); len(v) > 0 {
			mv = v[0]
		}
	}
	h := HeuristicBreakdown(b, a.S.Config.Weights)
	depth, nodes, hits, size := r.Depth, r.Nodes, r.TTHits, r.TTSize
	return Decision{Move: mv, Metrics: Metrics{
		Depth: &depth, Nodes: &nodes, TTHits: &hits, TTSize: &size, TimeUs: r.TimeUs,
		Values: r.Values[:], Heuristic: &h, Deterministic: r.Deterministic, CompletedDepths: r.CompletedDepths,
	}}
}

// NewAgent creates a built-in agent by id ("random", "greedy", "expectimax").
func NewAgent(id string, config map[string]any) (Agent, error) {
	switch id {
	case "random":
		return NewRandomAgent(), nil
	case "greedy":
		return GreedyAgent{}, nil
	case "expectimax":
		c, err := ParseConfig(config)
		if err != nil {
			return nil, err
		}
		return NewExpectimaxAgent(c), nil
	}
	return nil, fmt.Errorf("unknown agent '%s'", id)
}

// IsDeterministic reports whether the agent's decisions are reproducible.
func IsDeterministic(a Agent) bool {
	if e, ok := a.(*ExpectimaxAgent); ok {
		return !(e.S.Config.TimeBudgetMs > 0)
	}
	return true
}
