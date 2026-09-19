package ai_test

import (
	"testing"

	"g2048/ai"
	"g2048/engine"
	"g2048/internal/validate"
)

func TestAIFixture(t *testing.T) {
	r := validate.NewReport()
	validate.Run(r, "../../../spec/fixtures", "ai.json")
	for _, f := range r.Failures {
		t.Errorf("%s [%s]: %s", f.Fixture, f.Case, f.Message)
	}
	if r.Passed == 0 {
		t.Fatal("no cases checked")
	}
	t.Logf("ai.json: %d passed; search values bit-identical: %d/%d", r.Passed, validate.AIExact, validate.AITotal)
}

func TestSaturatingMerge(t *testing.T) {
	b := engine.MustBoard("ff00000000000000")
	nb, ok := ai.Move(ai.FromBoard(&b), engine.Left)
	if out := ai.ToBoard(nb); !ok || out.Hex() != "f000000000000000" {
		t.Fatalf("got %s", out.Hex())
	}
	g := engine.MustBoard("h000000000000000") // exponent 17 clamps to 15
	if ai.FromBoard(&g) != 0xf {
		t.Fatal("clamp failed")
	}
}

func TestTimeBudgetMode(t *testing.T) {
	c := ai.CanonicalConfig()
	c.TimeBudgetMs = 5
	c.MaxDepth = 8
	s := ai.NewSearch(c)
	b := engine.MustBoard("1024023713480379")
	r := s.Run(ai.FromBoard(&b))
	if r.Deterministic || r.Move < 0 || r.Depth < 1 || r.CompletedDepths[0] != 1 {
		t.Fatalf("unexpected result %+v", r)
	}
	// After an aborted iteration the TT must not hold garbage: a canonical
	// search on the same searcher must still agree with a fresh searcher.
	s.Config.TimeBudgetMs = 0
	s.Config.AutoDepth, s.Config.Depth = false, 3
	c2 := ai.CanonicalConfig()
	c2.AutoDepth, c2.Depth = false, 3
	r1 := s.Run(ai.FromBoard(&b))
	r2 := ai.NewSearch(c2).Run(ai.FromBoard(&b))
	for d := 0; d < 4; d++ {
		if (r1.Values[d] == nil) != (r2.Values[d] == nil) || (r1.Values[d] != nil && *r1.Values[d] != *r2.Values[d]) {
			t.Fatalf("values differ after timed search at %d", d)
		}
	}
}

func TestParseConfigRejectsNonIntegerWeights(t *testing.T) {
	if _, err := ai.ParseConfig(map[string]any{"weights": map[string]any{"mono": 1.5}}); err == nil {
		t.Fatal("expected error")
	}
	c, err := ai.ParseConfig(map[string]any{"depth": "auto", "maxDepth": 5.0})
	if err != nil || !c.AutoDepth || c.MaxDepth != 5 {
		t.Fatalf("parse failed: %v %+v", err, c)
	}
}

func BenchmarkSearchCanonical(b *testing.B) {
	bd := engine.MustBoard("1024023713480379")
	bb := ai.FromBoard(&bd)
	for i := 0; i < b.N; i++ {
		s := ai.NewSearch(ai.CanonicalConfig())
		s.Run(bb)
	}
}
