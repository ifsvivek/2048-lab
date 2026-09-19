package bench_test

import (
	"encoding/json"
	"testing"

	"g2048/bench"
	"g2048/internal/validate"
)

func TestBenchmarksFixture(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	r := validate.NewReport()
	validate.Run(r, "../../../spec/fixtures", "benchmarks.json")
	for _, f := range r.Failures {
		t.Errorf("%s [%s]: %s", f.Fixture, f.Case, f.Message)
	}
	if r.Passed == 0 {
		t.Fatal("no suites checked")
	}
}

func TestResultShape(t *testing.T) {
	s, err := bench.LoadSuite("../../../spec/benchmarks/engine-random-1k.json")
	if err != nil {
		t.Fatal(err)
	}
	s.Seeds.Count = 5
	res, err := bench.Run(s, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(res)
	var m map[string]any
	json.Unmarshal(data, &m)
	for _, k := range []string{"schemaVersion", "suiteId", "specVersion", "implementation", "environment", "agent", "deterministic", "startedAt", "finishedAt", "games", "summary", "checksum"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
	sum := m["summary"].(map[string]any)
	for _, k := range []string{"games", "avgScore", "medianScore", "minScore", "maxScore", "maxTile", "totalMoves", "wallMs", "cpuMs", "gamesPerSec", "movesPerSec", "decisionsPerSec", "nodes", "nodesPerSec", "peakMemoryBytes", "avgDecisionUs", "p50DecisionUs", "p99DecisionUs", "tileDistribution", "reachRates"} {
		if _, ok := sum[k]; !ok {
			t.Errorf("missing summary.%s", k)
		}
	}
	if _, ok := sum["reachRates"].(map[string]any)["2048"]; !ok {
		t.Error("reachRates keys must be decimal strings")
	}
	if m["implementation"].(map[string]any)["language"] != "go" {
		t.Error("language must be go")
	}
}

func TestSummaryStatistics(t *testing.T) {
	games := []bench.GameResult{{Score: 30, MaxTile: 2048}, {Score: 10, MaxTile: 256}, {Score: 20, MaxTile: 4096}, {Score: 40, MaxTile: 2048}}
	s := bench.Summarise(games, 1000, nil, nil, []float64{5, 1, 3, 2})
	if s.MedianScore != 30 || s.MinScore != 10 || s.MaxScore != 40 || s.AvgScore != 25 || s.MaxTile != 4096 {
		t.Fatalf("bad summary %+v", s)
	}
	if *s.P50DecisionUs != 3 || *s.P99DecisionUs != 5 || *s.AvgDecisionUs != 2.75 {
		t.Fatalf("bad percentiles")
	}
	if s.ReachRates.Values[2048] != 0.75 || s.TileDistribution.Values[2048] != 2 {
		t.Fatalf("bad rates")
	}
}
