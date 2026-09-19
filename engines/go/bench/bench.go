// Package bench runs benchmark suites (spec/benchmarks) and produces
// BenchmarkResult JSON (spec/schemas/benchmark-result.schema.json).
package bench

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"g2048/ai"
	"g2048/engine"
)

// Suite is a benchmark suite definition.
type Suite struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	SpecVersion int    `json:"specVersion"`
	Agent       struct {
		ID     string          `json:"id"`
		Config json.RawMessage `json:"config,omitempty"`
	} `json:"agent"`
	Seeds struct {
		Start uint32 `json:"start"`
		Count int    `json:"count"`
	} `json:"seeds"`
	MaxMoves      int      `json:"maxMoves"`
	TimeDecisions bool     `json:"timeDecisions"`
	Tags          []string `json:"tags,omitempty"`
}

// LoadSuite reads a suite file.
func LoadSuite(path string) (*Suite, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s Suite
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &s, nil
}

// HasTag reports whether the suite carries a tag.
func (s *Suite) HasTag(t string) bool { return slices.Contains(s.Tags, t) }

// GameResult is one game's outcome.
type GameResult struct {
	Seed        uint32  `json:"seed"`
	Score       int64   `json:"score"`
	MaxTile     int64   `json:"maxTile"`
	MoveCount   int     `json:"moveCount"`
	Over        bool    `json:"over"`
	HistoryHash string  `json:"historyHash"`
	WallMs      float64 `json:"wallMs"`
	Nodes       int64   `json:"nodes"`
}

// IntKeyMap is a map with decimal-string keys serialised in numeric order.
type IntKeyMap[V any] struct {
	Keys   []int64
	Values map[int64]V
}

func (m IntKeyMap[V]) MarshalJSON() ([]byte, error) {
	keys := slices.Clone(m.Keys)
	slices.Sort(keys)
	var sb strings.Builder
	sb.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte(',')
		}
		v, err := json.Marshal(m.Values[k])
		if err != nil {
			return nil, err
		}
		sb.WriteString(`"` + strconv.FormatInt(k, 10) + `":`)
		sb.Write(v)
	}
	sb.WriteByte('}')
	return []byte(sb.String()), nil
}

func (m *IntKeyMap[V]) set(k int64, v V) {
	if m.Values == nil {
		m.Values = map[int64]V{}
	}
	if _, ok := m.Values[k]; !ok {
		m.Keys = append(m.Keys, k)
	}
	m.Values[k] = v
}

// Summary holds aggregate statistics (definitions match the TS sim.ts).
type Summary struct {
	Games            int                `json:"games"`
	AvgScore         float64            `json:"avgScore"`
	MedianScore      float64            `json:"medianScore"`
	MinScore         int64              `json:"minScore"`
	MaxScore         int64              `json:"maxScore"`
	MaxTile          int64              `json:"maxTile"`
	TotalMoves       int64              `json:"totalMoves"`
	WallMs           float64            `json:"wallMs"`
	CPUMs            *float64           `json:"cpuMs"`
	GamesPerSec      float64            `json:"gamesPerSec"`
	MovesPerSec      float64            `json:"movesPerSec"`
	DecisionsPerSec  float64            `json:"decisionsPerSec"`
	Nodes            int64              `json:"nodes"`
	NodesPerSec      float64            `json:"nodesPerSec"`
	PeakMemoryBytes  *int64             `json:"peakMemoryBytes"`
	AvgDecisionUs    *float64           `json:"avgDecisionUs"`
	P50DecisionUs    *float64           `json:"p50DecisionUs"`
	P99DecisionUs    *float64           `json:"p99DecisionUs"`
	TileDistribution IntKeyMap[int]     `json:"tileDistribution"`
	ReachRates       IntKeyMap[float64] `json:"reachRates"`
}

// Implementation describes this port.
type Implementation struct {
	Language       string `json:"language"`
	Runtime        string `json:"runtime"`
	RuntimeVersion string `json:"runtimeVersion"`
	EngineVersion  string `json:"engineVersion"`
	Platform       string `json:"platform"`
}

// AgentRef identifies the agent and its (suite-supplied) config.
type AgentRef struct {
	ID     string          `json:"id"`
	Config json.RawMessage `json:"config,omitempty"`
}

// Result is a BenchmarkResult.
type Result struct {
	SchemaVersion  int            `json:"schemaVersion"`
	SuiteID        string         `json:"suiteId"`
	SpecVersion    int            `json:"specVersion"`
	Implementation Implementation `json:"implementation"`
	Environment    map[string]any `json:"environment"`
	Agent          AgentRef       `json:"agent"`
	Deterministic  bool           `json:"deterministic"`
	StartedAt      string         `json:"startedAt"`
	FinishedAt     string         `json:"finishedAt"`
	Games          []GameResult   `json:"games"`
	Summary        Summary        `json:"summary"`
	Checksum       string         `json:"checksum"`
}

// ReachTiles are the reachRates keys.
var ReachTiles = []int64{2048, 4096, 8192, 16384, 32768, 65536}

// PlayResult is the outcome of Play.
type PlayResult struct {
	Game   *engine.Game
	Nodes  int64
	WallMs float64
}

// Play runs an agent on seed until the game ends or maxMoves (0 = unlimited).
func Play(agent ai.Agent, seed uint32, maxMoves int, onDecision func(timeUs int64)) (PlayResult, error) {
	t0 := time.Now()
	g := engine.NewGame(seed)
	agent.Reset(g.Seed)
	var nodes int64
	for (maxMoves <= 0 || g.MoveCount < maxMoves) && !g.Over() {
		d := agent.Decide(&g.Board)
		if d.Move < 0 {
			return PlayResult{}, fmt.Errorf("agent %s returned no move at %d", agent.ID(), g.MoveCount)
		}
		if _, ok := g.Apply(d.Move); !ok {
			return PlayResult{}, fmt.Errorf("agent %s returned invalid move %d at %d", agent.ID(), d.Move, g.MoveCount)
		}
		if d.Metrics.Nodes != nil {
			nodes += *d.Metrics.Nodes
		}
		if onDecision != nil {
			onDecision(d.Metrics.TimeUs)
		}
	}
	return PlayResult{Game: g, Nodes: nodes, WallMs: msSince(t0)}, nil
}

func msSince(t time.Time) float64 { return float64(time.Since(t).Nanoseconds()) / 1e6 }

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[min(len(sorted)-1, int(math.Floor(p*float64(len(sorted)))))]
}

// Summarise computes the summary block.
func Summarise(games []GameResult, wallMs float64, cpuMs *float64, peak *int64, decisions []float64) Summary {
	s := Summary{Games: len(games), WallMs: wallMs, CPUMs: cpuMs, PeakMemoryBytes: peak}
	scores := make([]int64, len(games))
	var total int64
	for i, g := range games {
		scores[i] = g.Score
		total += g.Score
		s.TotalMoves += int64(g.MoveCount)
		s.Nodes += g.Nodes
		s.MaxTile = max(s.MaxTile, g.MaxTile)
		cur := 0
		if s.TileDistribution.Values != nil {
			cur = s.TileDistribution.Values[g.MaxTile]
		}
		s.TileDistribution.set(g.MaxTile, cur+1)
	}
	if s.TileDistribution.Values == nil {
		s.TileDistribution.Values = map[int64]int{}
	}
	slices.Sort(scores)
	if n := len(games); n > 0 {
		s.AvgScore = float64(total) / float64(n)
		s.MedianScore = float64(scores[n/2])
		s.MinScore = scores[0]
		s.MaxScore = scores[n-1]
	}
	for _, t := range ReachTiles {
		r := 0.0
		if len(games) > 0 {
			c := 0
			for _, g := range games {
				if g.MaxTile >= t {
					c++
				}
			}
			r = float64(c) / float64(len(games))
		}
		s.ReachRates.set(t, r)
	}
	secs := wallMs / 1000
	if secs > 0 {
		s.GamesPerSec = float64(len(games)) / secs
		s.MovesPerSec = float64(s.TotalMoves) / secs
		s.DecisionsPerSec = s.MovesPerSec
		s.NodesPerSec = float64(s.Nodes) / secs
	}
	if len(decisions) > 0 {
		sorted := slices.Clone(decisions)
		sort.Float64s(sorted)
		sum := 0.0
		for _, x := range sorted {
			sum += x
		}
		avg := sum / float64(len(sorted))
		p50, p99 := percentile(sorted, 0.5), percentile(sorted, 0.99)
		s.AvgDecisionUs, s.P50DecisionUs, s.P99DecisionUs = &avg, &p50, &p99
	}
	return s
}

// Checksum is fnv1a32 over the concatenated historyHash strings.
func Checksum(games []GameResult) string {
	var b []byte
	for _, g := range games {
		b = append(b, g.HistoryHash...)
	}
	return engine.HashHex(engine.Fnv1a32(b))
}

// ImplementationInfo describes the Go port.
func ImplementationInfo() Implementation {
	return Implementation{Language: "go", Runtime: "go", RuntimeVersion: runtime.Version(), EngineVersion: engine.EngineVersion, Platform: runtime.GOOS}
}

// Environment collects host facts.
func Environment() map[string]any {
	env := map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "cpus": runtime.NumCPU()}
	if f, err := os.Open("/proc/cpuinfo"); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := sc.Text()
			if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "model name" {
				env["cpu"] = strings.TrimSpace(v)
				break
			}
		}
	}
	if f, err := os.Open("/proc/meminfo"); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			var kb int64
			if n, _ := fmt.Sscanf(sc.Text(), "MemTotal: %d kB", &kb); n == 1 {
				env["memoryBytes"] = kb * 1024
				break
			}
		}
	}
	return env
}

func isoNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// Run executes a suite. Progress lines go to progress (may be nil).
func Run(suite *Suite, progress io.Writer) (*Result, error) {
	if suite.SpecVersion != engine.SpecVersion {
		return nil, fmt.Errorf("suite %s targets spec v%d", suite.ID, suite.SpecVersion)
	}
	var cfg map[string]any
	if len(suite.Agent.Config) > 0 && string(suite.Agent.Config) != "null" {
		if err := json.Unmarshal(suite.Agent.Config, &cfg); err != nil {
			return nil, fmt.Errorf("agent config: %w", err)
		}
	}
	agent, err := ai.NewAgent(suite.Agent.ID, cfg)
	if err != nil {
		return nil, err
	}
	startedAt := isoNow()
	cpu0 := cpuMs()
	t0 := time.Now()
	var decisions []float64
	var onDecision func(int64)
	if suite.TimeDecisions {
		decisions = make([]float64, 0, 1024)
		onDecision = func(us int64) { decisions = append(decisions, float64(us)) }
	}
	games := make([]GameResult, 0, suite.Seeds.Count)
	for i := 0; i < suite.Seeds.Count; i++ {
		seed := suite.Seeds.Start + uint32(i)
		pr, err := Play(agent, seed, suite.MaxMoves, onDecision)
		if err != nil {
			return nil, err
		}
		g := pr.Game
		r := GameResult{
			Seed: seed, Score: g.Score, MaxTile: int64(1) << g.Board.MaxExponent(), MoveCount: g.MoveCount,
			Over: g.Over(), HistoryHash: g.HistoryHash(), WallMs: pr.WallMs, Nodes: pr.Nodes,
		}
		games = append(games, r)
		if progress != nil && (suite.Seeds.Count <= 100 || (i+1)%100 == 0 || i+1 == suite.Seeds.Count) {
			fmt.Fprintf(progress, "[%s] game %d/%d seed=%d score=%d maxTile=%d moves=%d %.0fms\n",
				suite.ID, i+1, suite.Seeds.Count, seed, r.Score, r.MaxTile, r.MoveCount, r.WallMs)
		}
	}
	wallMs := msSince(t0)
	var cpu *float64
	if c1 := cpuMs(); c1 != nil && cpu0 != nil {
		d := *c1 - *cpu0
		cpu = &d
	}
	var decs []float64
	if suite.TimeDecisions {
		decs = decisions
	}
	return &Result{
		SchemaVersion:  1,
		SuiteID:        suite.ID,
		SpecVersion:    engine.SpecVersion,
		Implementation: ImplementationInfo(),
		Environment:    Environment(),
		Agent:          AgentRef{ID: suite.Agent.ID, Config: suite.Agent.Config},
		Deterministic:  ai.IsDeterministic(agent),
		StartedAt:      startedAt,
		FinishedAt:     isoNow(),
		Games:          games,
		Summary:        Summarise(games, wallMs, cpu, peakMemory(), decs),
		Checksum:       Checksum(games),
	}, nil
}
