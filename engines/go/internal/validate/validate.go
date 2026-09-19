// Package validate checks this port against the cross-language fixtures in
// spec/fixtures. It is shared by the `g2048 validate` command and the tests.
package validate

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"

	"g2048/ai"
	"g2048/bench"
	"g2048/engine"
)

// Failure is one failed fixture case.
type Failure struct {
	Fixture string `json:"fixture"`
	Case    string `json:"case"`
	Message string `json:"message"`
}

// Report accumulates results.
type Report struct {
	Language string    `json:"language"`
	Passed   int       `json:"passed"`
	Failed   int       `json:"failed"`
	Failures []Failure `json:"failures"`
	// PerFixture counts passed/failed cases by fixture file.
	PerFixture map[string][2]int `json:"-"`
}

// NewReport creates an empty report.
func NewReport() *Report {
	return &Report{Language: "go", Failures: []Failure{}, PerFixture: map[string][2]int{}}
}

func (r *Report) check(fixture, name string, ok bool, format string, args ...any) bool {
	pf := r.PerFixture[fixture]
	if ok {
		r.Passed++
		pf[0]++
	} else {
		r.Failed++
		pf[1]++
		r.Failures = append(r.Failures, Failure{Fixture: fixture, Case: name, Message: fmt.Sprintf(format, args...)})
	}
	r.PerFixture[fixture] = pf
	return ok
}

// fail records a failure without a condition.
func (r *Report) fail(fixture, name, format string, args ...any) {
	r.check(fixture, name, false, format, args...)
}

func load(dir, name string, v any) error {
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

// Fixtures lists the fixture files in check order.
var Fixtures = []string{"rng.json", "moves.json", "spawn.json", "hash.json", "games.json", "replays.json", "codes.json", "ai.json", "benchmarks.json"}

// Options control what is checked.
type Options struct {
	// SkipBenchmarks skips running the benchmark suites (benchmarks.json).
	SkipBenchmarks bool
}

// All runs every fixture check against dir.
func All(dir string, opts Options) *Report {
	r := NewReport()
	for _, f := range Fixtures {
		if f == "benchmarks.json" && opts.SkipBenchmarks {
			continue
		}
		Run(r, dir, f)
	}
	return r
}

// Run checks a single fixture file.
func Run(r *Report, dir, name string) {
	var err error
	switch name {
	case "rng.json":
		err = checkRng(r, dir)
	case "moves.json":
		err = checkMoves(r, dir)
	case "spawn.json":
		err = checkSpawn(r, dir)
	case "hash.json":
		err = checkHash(r, dir)
	case "games.json":
		err = checkGames(r, dir)
	case "replays.json":
		err = checkReplays(r, dir)
	case "codes.json":
		err = checkCodes(r, dir)
	case "ai.json":
		err = checkAI(r, dir)
	case "benchmarks.json":
		err = checkBenchmarks(r, dir)
	default:
		err = fmt.Errorf("unknown fixture")
	}
	if err != nil {
		r.fail(name, "load", "%v", err)
	}
}

func checkRng(r *Report, dir string) error {
	var fx struct {
		Cases []struct {
			Seed  uint32              `json:"seed"`
			State engine.RngState     `json:"state"`
			Next  []uint32            `json:"next"`
			Below map[string][]uint32 `json:"below"`
		} `json:"cases"`
	}
	if err := load(dir, "rng.json", &fx); err != nil {
		return err
	}
	for _, c := range fx.Cases {
		id := fmt.Sprintf("seed=%d", c.Seed)
		st := engine.Mix32(c.Seed)
		r.check("rng.json", id+" state", st == c.State, "state %v, want %v", st, c.State)
		g := engine.NewRng(st)
		for i, want := range c.Next {
			if got := g.Next(); got != want {
				r.fail("rng.json", id+" next", "next[%d]=%d, want %d", i, got, want)
				goto below
			}
		}
		r.check("rng.json", id+" next", true, "")
	below:
		for ns, seq := range c.Below {
			n, err := strconv.ParseUint(ns, 10, 64)
			if err != nil {
				return err
			}
			g := engine.RngFromSeed(c.Seed)
			ok := true
			for i, want := range seq {
				if got := g.Below(n); got != want {
					r.fail("rng.json", id+" below("+ns+")", "below[%d]=%d, want %d", i, got, want)
					ok = false
					break
				}
			}
			if ok {
				r.check("rng.json", id+" below("+ns+")", true, "")
			}
		}
	}
	return nil
}

func checkMoves(r *Report, dir string) error {
	var fx struct {
		Cases []struct {
			Board   string `json:"board"`
			Results []struct {
				Dir     string `json:"dir"`
				Board   string `json:"board"`
				Gained  int64  `json:"gained"`
				Changed bool   `json:"changed"`
			} `json:"results"`
			Over bool `json:"over"`
		} `json:"cases"`
	}
	if err := load(dir, "moves.json", &fx); err != nil {
		return err
	}
	for _, c := range fx.Cases {
		b, err := engine.BoardFromHex(c.Board)
		if err != nil {
			r.fail("moves.json", c.Board, "%v", err)
			continue
		}
		for _, res := range c.Results {
			d, _ := engine.ParseDirection(res.Dir)
			nb, g, ch := b.Move(d)
			id := c.Board + " " + res.Dir
			r.check("moves.json", id, nb.Hex() == res.Board && g == res.Gained && ch == res.Changed && b.CanMove(d) == res.Changed,
				"got board=%s gained=%d changed=%v canMove=%v, want %s %d %v", nb.Hex(), g, ch, b.CanMove(d), res.Board, res.Gained, res.Changed)
		}
		r.check("moves.json", c.Board+" over", b.IsOver() == c.Over, "over=%v, want %v", b.IsOver(), c.Over)
	}
	return nil
}

func checkSpawn(r *Report, dir string) error {
	var fx struct {
		Cases []struct {
			Board         string          `json:"board"`
			RngState      engine.RngState `json:"rngState"`
			Result        string          `json:"result"`
			RngStateAfter engine.RngState `json:"rngStateAfter"`
			Spawn         *struct {
				Index    int   `json:"index"`
				Exponent uint8 `json:"exponent"`
			} `json:"spawn"`
		} `json:"cases"`
	}
	if err := load(dir, "spawn.json", &fx); err != nil {
		return err
	}
	for i, c := range fx.Cases {
		b := engine.MustBoard(c.Board)
		g := engine.NewRng(c.RngState)
		idx, e, ok := b.Spawn(g)
		good := b.Hex() == c.Result && g.State() == c.RngStateAfter && ok == (c.Spawn != nil)
		if good && ok {
			good = idx == c.Spawn.Index && e == c.Spawn.Exponent
		}
		r.check("spawn.json", fmt.Sprintf("#%d %s", i, c.Board), good, "got %s idx=%d exp=%d ok=%v state=%v", b.Hex(), idx, e, ok, g.State())
	}
	return nil
}

func checkHash(r *Report, dir string) error {
	var fx struct {
		Cases []struct {
			Board       string `json:"board"`
			BoardHash   string `json:"boardHash"`
			Prev        string `json:"prev"`
			Dir         int    `json:"dir"`
			HistoryStep string `json:"historyStep"`
		} `json:"cases"`
	}
	if err := load(dir, "hash.json", &fx); err != nil {
		return err
	}
	for _, c := range fx.Cases {
		b := engine.MustBoard(c.Board)
		bh := engine.HashHex(engine.BoardHash(&b))
		prev, err := strconv.ParseUint(c.Prev, 16, 32)
		if err != nil {
			return err
		}
		hs := engine.HashHex(engine.HistoryStep(uint32(prev), &b, c.Dir))
		r.check("hash.json", c.Board, bh == c.BoardHash && hs == c.HistoryStep, "boardHash=%s historyStep=%s, want %s %s", bh, hs, c.BoardHash, c.HistoryStep)
	}
	return nil
}

type finalJSON struct {
	Board       string `json:"board"`
	Score       int64  `json:"score"`
	MoveCount   int    `json:"moveCount"`
	MaxTile     int64  `json:"maxTile"`
	Over        bool   `json:"over"`
	HistoryHash string `json:"historyHash"`
}

func sameFinal(s engine.Snapshot, f finalJSON) bool {
	return s.Board == f.Board && s.Score == f.Score && s.MoveCount == f.MoveCount && s.MaxTile == f.MaxTile && s.Over == f.Over && s.HistoryHash == f.HistoryHash
}

func checkGames(r *Report, dir string) error {
	var fx struct {
		NewGames []struct {
			Seed        uint32          `json:"seed"`
			Board       string          `json:"board"`
			RngState    engine.RngState `json:"rngState"`
			HistoryHash string          `json:"historyHash"`
		} `json:"newGames"`
		Games []struct {
			Seed  uint32    `json:"seed"`
			Agent string    `json:"agent"`
			Moves string    `json:"moves"`
			Final finalJSON `json:"final"`
		} `json:"games"`
	}
	if err := load(dir, "games.json", &fx); err != nil {
		return err
	}
	for _, c := range fx.NewGames {
		g := engine.NewGame(c.Seed)
		r.check("games.json", fmt.Sprintf("newGame seed=%d", c.Seed),
			g.Board.Hex() == c.Board && g.Rng.State() == c.RngState && g.HistoryHash() == c.HistoryHash,
			"board=%s rng=%v hash=%s", g.Board.Hex(), g.Rng.State(), g.HistoryHash())
	}
	for _, c := range fx.Games {
		id := fmt.Sprintf("game seed=%d agent=%s", c.Seed, c.Agent)
		g, err := engine.Simulate(c.Seed, c.Moves)
		if err != nil {
			r.fail("games.json", id+" replay", "%v", err)
		} else {
			s := g.Snapshot()
			r.check("games.json", id+" replay", sameFinal(s, c.Final), "final %+v, want %+v", s, c.Final)
		}
		var agent ai.Agent
		switch c.Agent {
		case "random":
			agent = ai.NewRandomAgent()
		case "expectimax-d2":
			agent, _ = ai.NewAgent("expectimax", map[string]any{"depth": 2.0})
		default:
			continue
		}
		// Random games run to completion; expectimax-d2 games were generated
		// with maxMoves=1500, so cap at the recorded length when not over.
		limit := 0
		if !c.Final.Over {
			limit = len(c.Moves)
		}
		pr, err := bench.Play(agent, c.Seed, limit, nil)
		if err != nil {
			r.fail("games.json", id+" agent", "%v", err)
			continue
		}
		r.check("games.json", id+" agent", pr.Game.Moves() == c.Moves && sameFinal(pr.Game.Snapshot(), c.Final),
			"agent replay diverged (moves %d vs %d)", len(pr.Game.Moves()), len(c.Moves))
	}
	return nil
}

func checkReplays(r *Report, dir string) error {
	var fx struct {
		Cases []struct {
			Name   string `json:"name"`
			Seed   uint32 `json:"seed"`
			Moves  string `json:"moves"`
			Expect struct {
				OK        bool      `json:"ok"`
				Final     finalJSON `json:"final"`
				Error     string    `json:"error"`
				MoveIndex *int      `json:"moveIndex"`
			} `json:"expect"`
		} `json:"cases"`
	}
	if err := load(dir, "replays.json", &fx); err != nil {
		return err
	}
	for _, c := range fx.Cases {
		snap, err := engine.VerifyReplay(1, c.Seed, c.Moves, nil)
		if c.Expect.OK {
			ok := err == nil && sameFinal(snap, c.Expect.Final)
			r.check("replays.json", c.Name, ok, "err=%v final=%+v", err, snap)
			// also check that a correct claim verifies and a wrong claim is rejected
			if ok {
				f := c.Expect.Final
				claim := &engine.FinalClaim{Board: &f.Board, Score: &f.Score, MoveCount: &f.MoveCount, HistoryHash: &f.HistoryHash}
				_, err := engine.VerifyReplay(1, c.Seed, c.Moves, claim)
				r.check("replays.json", c.Name+" claim", err == nil, "valid claim rejected: %v", err)
				bad := f.Score + 4
				_, err = engine.VerifyReplay(1, c.Seed, c.Moves, &engine.FinalClaim{Score: &bad})
				re, _ := err.(*engine.ReplayError)
				r.check("replays.json", c.Name+" bad-claim", re != nil && re.Code == engine.ErrFinalMismatch, "want FINAL_MISMATCH, got %v", err)
				_, err = engine.VerifyReplay(2, c.Seed, c.Moves, nil)
				re, _ = err.(*engine.ReplayError)
				r.check("replays.json", c.Name+" spec-version", re != nil && re.Code == engine.ErrSpecVersion, "want SPEC_VERSION, got %v", err)
			}
			continue
		}
		re, isRE := err.(*engine.ReplayError)
		ok := isRE && re.Code == c.Expect.Error
		if ok && c.Expect.MoveIndex != nil {
			ok = re.MoveIndex == *c.Expect.MoveIndex
		}
		r.check("replays.json", c.Name, ok, "got %v, want %s at %v", err, c.Expect.Error, c.Expect.MoveIndex)
	}
	return nil
}

func checkCodes(r *Report, dir string) error {
	var fx struct {
		Alphabet string `json:"alphabet"`
		Cases    []struct {
			Input      string  `json:"input"`
			Normalized *string `json:"normalized"`
			Formatted  *string `json:"formatted"`
		} `json:"cases"`
	}
	if err := load(dir, "codes.json", &fx); err != nil {
		return err
	}
	r.check("codes.json", "alphabet", fx.Alphabet == engine.ReplayAlphabet, "alphabet mismatch")
	for _, c := range fx.Cases {
		n, ok := engine.NormalizeReplayCode(c.Input)
		var good bool
		if c.Normalized == nil {
			good = !ok
		} else {
			good = ok && n == *c.Normalized && c.Formatted != nil && engine.FormatReplayCode(n) == *c.Formatted
		}
		r.check("codes.json", c.Input, good, "normalized=%q ok=%v", n, ok)
	}
	return nil
}

type aiFixture struct {
	Weights struct {
		Canonical  ai.Weights `json:"canonical"`
		AllWeights ai.Weights `json:"allWeights"`
	} `json:"weights"`
	Lines []struct {
		Line       uint16          `json:"line"`
		Features   ai.LineFeatures `json:"features"`
		Canonical  float64         `json:"canonical"`
		AllWeights float64         `json:"allWeights"`
	} `json:"lines"`
	Evaluations []struct {
		Board      string  `json:"board"`
		Canonical  float64 `json:"canonical"`
		AllWeights float64 `json:"allWeights"`
	} `json:"evaluations"`
	BitboardMoves []struct {
		Board   string `json:"board"`
		Results []struct {
			Changed bool   `json:"changed"`
			Board   string `json:"board"`
		} `json:"results"`
	} `json:"bitboardMoves"`
	Searches []struct {
		Board   string          `json:"board"`
		Profile string          `json:"profile"`
		Config  json.RawMessage `json:"config"`
		Move    *string         `json:"move"`
		Depth   int             `json:"depth"`
		Values  []*float64      `json:"values"`
	} `json:"searches"`
}

func relClose(a, b float64) bool {
	if a == b {
		return true
	}
	return math.Abs(a-b) <= 1e-9*math.Max(math.Abs(a), math.Abs(b))
}

// AIExact counts search values that were bit-identical (informational).
var AIExact, AITotal int

func checkAI(r *Report, dir string) error {
	var fx aiFixture
	if err := load(dir, "ai.json", &fx); err != nil {
		return err
	}
	const F = "ai.json"
	r.check(F, "canonical weights", fx.Weights.Canonical == ai.HeuristicV1, "canonical weights %v", fx.Weights.Canonical)
	tc, ta := ai.LineTable(fx.Weights.Canonical), ai.LineTable(fx.Weights.AllWeights)
	for _, l := range fx.Lines {
		f := ai.Features(l.Line)
		r.check(F, fmt.Sprintf("line %d", l.Line), f == l.Features && tc[l.Line] == l.Canonical && ta[l.Line] == l.AllWeights,
			"features %+v canonical=%v allWeights=%v, want %+v %v %v", f, tc[l.Line], ta[l.Line], l.Features, l.Canonical, l.AllWeights)
	}
	for _, e := range fx.Evaluations {
		b := engine.MustBoard(e.Board)
		bb := ai.FromBoard(&b)
		vc := ai.Evaluate(bb, tc, fx.Weights.Canonical.Corner)
		va := ai.Evaluate(bb, ta, fx.Weights.AllWeights.Corner)
		r.check(F, "eval "+e.Board, vc == e.Canonical && va == e.AllWeights, "canonical=%v allWeights=%v, want %v %v", vc, va, e.Canonical, e.AllWeights)
	}
	for _, m := range fx.BitboardMoves {
		b := engine.MustBoard(m.Board)
		bb := ai.FromBoard(&b)
		for d, res := range m.Results {
			nb, ch := ai.Move(bb, d)
			out := ai.ToBoard(nb)
			r.check(F, fmt.Sprintf("bbmove %s %c", m.Board, engine.DirectionLetters[d]), out.Hex() == res.Board && ch == res.Changed,
				"got %s %v, want %s %v", out.Hex(), ch, res.Board, res.Changed)
		}
	}
	searchers := map[string]*ai.Search{}
	for _, s := range fx.Searches {
		id := fmt.Sprintf("search %s %s", s.Profile, s.Board)
		srch := searchers[string(s.Config)]
		if srch == nil {
			var m map[string]any
			if err := json.Unmarshal(s.Config, &m); err != nil {
				return err
			}
			c, err := ai.ParseConfig(m)
			if err != nil {
				r.fail(F, id, "config: %v", err)
				continue
			}
			c.TTBits = 18
			srch = ai.NewSearch(c)
			searchers[string(s.Config)] = srch
		}
		b := engine.MustBoard(s.Board)
		res := srch.Run(ai.FromBoard(&b))
		move := "null"
		if res.Move >= 0 {
			move = string(engine.DirectionLetters[res.Move])
		}
		want := "null"
		if s.Move != nil {
			want = *s.Move
		}
		ok := move == want && res.Depth == s.Depth && len(s.Values) == 4
		msg := fmt.Sprintf("move=%s depth=%d, want %s %d", move, res.Depth, want, s.Depth)
		for d := 0; ok && d < 4; d++ {
			got, exp := res.Values[d], s.Values[d]
			switch {
			case (got == nil) != (exp == nil):
				ok = false
				msg = fmt.Sprintf("values[%d] null mismatch", d)
			case got != nil:
				AITotal++
				if *got == *exp {
					AIExact++
				}
				if !relClose(*got, *exp) {
					ok = false
					msg = fmt.Sprintf("values[%d]=%v, want %v", d, *got, *exp)
				}
			}
		}
		r.check(F, id, ok, "%s", msg)
	}
	return nil
}

func checkBenchmarks(r *Report, dir string) error {
	var fx struct {
		Suites map[string]struct {
			Checksum   string `json:"checksum"`
			Games      int    `json:"games"`
			TotalMoves int64  `json:"totalMoves"`
			TotalScore int64  `json:"totalScore"`
			MaxScore   int64  `json:"maxScore"`
		} `json:"suites"`
	}
	if err := load(dir, "benchmarks.json", &fx); err != nil {
		return err
	}
	ids := make([]string, 0, len(fx.Suites))
	for id := range fx.Suites {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	for _, id := range ids {
		want := fx.Suites[id]
		suite, err := bench.LoadSuite(filepath.Join(dir, "..", "benchmarks", id+".json"))
		if err != nil {
			r.fail("benchmarks.json", id, "%v", err)
			continue
		}
		if suite.HasTag("heavy") {
			continue
		}
		res, err := bench.Run(suite, nil)
		if err != nil {
			r.fail("benchmarks.json", id, "%v", err)
			continue
		}
		var total int64
		for _, g := range res.Games {
			total += g.Score
		}
		s := res.Summary
		r.check("benchmarks.json", id, res.Checksum == want.Checksum && s.Games == want.Games && s.TotalMoves == want.TotalMoves && total == want.TotalScore && s.MaxScore == want.MaxScore,
			"checksum=%s games=%d totalMoves=%d totalScore=%d maxScore=%d, want %+v", res.Checksum, s.Games, s.TotalMoves, total, s.MaxScore, want)
	}
	return nil
}
