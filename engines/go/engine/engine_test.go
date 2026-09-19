package engine_test

import (
	"testing"
	"time"

	"g2048/engine"
	"g2048/internal/validate"
)

const fixtures = "../../../spec/fixtures"

func runFixture(t *testing.T, name string) {
	t.Helper()
	r := validate.NewReport()
	validate.Run(r, fixtures, name)
	for _, f := range r.Failures {
		t.Errorf("%s [%s]: %s", f.Fixture, f.Case, f.Message)
	}
	if r.Passed == 0 {
		t.Fatalf("%s: no cases checked", name)
	}
	t.Logf("%s: %d passed, %d failed", name, r.Passed, r.Failed)
}

func TestRngFixture(t *testing.T)     { runFixture(t, "rng.json") }
func TestMovesFixture(t *testing.T)   { runFixture(t, "moves.json") }
func TestSpawnFixture(t *testing.T)   { runFixture(t, "spawn.json") }
func TestHashFixture(t *testing.T)    { runFixture(t, "hash.json") }
func TestGamesFixture(t *testing.T)   { runFixture(t, "games.json") }
func TestReplaysFixture(t *testing.T) { runFixture(t, "replays.json") }
func TestCodesFixture(t *testing.T)   { runFixture(t, "codes.json") }

func TestBoardHexRoundTrip(t *testing.T) {
	for _, h := range []string{"0000000000000000", "0123456789abcdef", "ghijklmnopqrstuv"} {
		b, err := engine.BoardFromHex(h)
		if err != nil || b.Hex() != h {
			t.Errorf("round trip %s -> %s (%v)", h, b.Hex(), err)
		}
	}
	if b, err := engine.BoardFromHex("0123456789ABCDEF"); err != nil || b.Hex() != "0123456789abcdef" {
		t.Errorf("upper-case hex not accepted")
	}
	for _, bad := range []string{"", "000", "000000000000000!"} {
		if _, err := engine.BoardFromHex(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
	b := engine.MustBoard("1000000000b00002")
	m, err := engine.BoardFromMatrix(b.Matrix())
	if err != nil || m != b {
		t.Errorf("matrix round trip failed: %v", err)
	}
}

func TestInvalidMoveLeavesStateUnchanged(t *testing.T) {
	g := engine.NewGame(12) // board 0000000110000000
	before := *g
	for d := 0; d < 4; d++ {
		if !g.Board.CanMove(d) {
			if _, ok := g.Apply(d); ok {
				t.Fatalf("invalid move %d applied", d)
			}
			if g.Board != before.Board || g.Rng != before.Rng || g.Hash != before.Hash || g.MoveCount != 0 {
				t.Fatalf("state changed by invalid move")
			}
		}
	}
}

func TestIDs(t *testing.T) {
	id := engine.ULID(time.Now())
	if !engine.IsULID(id) {
		t.Errorf("bad ULID %s", id)
	}
	code := engine.GenerateReplayCode()
	n, ok := engine.NormalizeReplayCode(code)
	if !ok || engine.FormatReplayCode(n) != code {
		t.Errorf("bad replay code %s", code)
	}
}
