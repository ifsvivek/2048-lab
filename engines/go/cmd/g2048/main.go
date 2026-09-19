// Command g2048 is the Go port's CLI: validate, bench, play, serve.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"g2048/ai"
	"g2048/bench"
	"g2048/engine"
	"g2048/internal/validate"
)

const usage = `usage: g2048 <command> [flags]

commands:
  validate [--fixtures DIR] [--json] [--skip-bench]   run every spec fixture check
  bench --suite FILE [--out FILE]                      run a benchmark suite, emit BenchmarkResult JSON
  play --seed N [--agent expectimax|random|greedy] [--depth auto|N]
  serve [--addr :8080] [--agent expectimax] [--depth auto|N] [--time-budget-ms N]
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "validate":
		err = cmdValidate(os.Args[2:])
	case "bench":
		err = cmdBench(os.Args[2:])
	case "play":
		err = cmdPlay(os.Args[2:])
	case "serve":
		err = cmdServe(os.Args[2:])
	case "-h", "--help", "help":
		fmt.Print(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func defaultFixtures() string {
	for _, c := range []string{"../../spec/fixtures", "spec/fixtures", "../spec/fixtures", "../../../spec/fixtures"} {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return "../../spec/fixtures"
}

func cmdValidate(args []string) error {
	fs := flag.NewFlagSet("validate", flag.ExitOnError)
	dir := fs.String("fixtures", defaultFixtures(), "fixtures directory")
	asJSON := fs.Bool("json", false, "emit a JSON report")
	skip := fs.Bool("skip-bench", false, "skip running benchmark suites")
	fs.Parse(args)
	r := validate.All(*dir, validate.Options{SkipBenchmarks: *skip})
	if *asJSON {
		out, _ := json.Marshal(r)
		fmt.Println(string(out))
	} else {
		fmt.Printf("go engine %s — fixtures: %s\n", engine.EngineVersion, *dir)
		for _, f := range validate.Fixtures {
			if pf, ok := r.PerFixture[f]; ok {
				status := "ok"
				if pf[1] > 0 {
					status = "FAIL"
				}
				fmt.Printf("  %-16s %4d passed %4d failed  %s\n", f, pf[0], pf[1], status)
			}
		}
		for _, f := range r.Failures {
			fmt.Printf("  FAIL %s [%s]: %s\n", f.Fixture, f.Case, f.Message)
		}
		fmt.Printf("%d passed, %d failed\n", r.Passed, r.Failed)
	}
	if r.Failed > 0 {
		os.Exit(1)
	}
	return nil
}

func cmdBench(args []string) error {
	fs := flag.NewFlagSet("bench", flag.ExitOnError)
	suitePath := fs.String("suite", "", "suite JSON file")
	out := fs.String("out", "", "output file (default stdout)")
	fs.Parse(args)
	if *suitePath == "" {
		return fmt.Errorf("--suite is required")
	}
	suite, err := bench.LoadSuite(*suitePath)
	if err != nil {
		return err
	}
	res, err := bench.Run(suite, os.Stderr)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	s := res.Summary
	fmt.Fprintf(os.Stderr, "[%s] checksum=%s games=%d moves=%d wall=%.0fms moves/s=%.0f games/s=%.2f nodes/s=%.0f\n",
		suite.ID, res.Checksum, s.Games, s.TotalMoves, s.WallMs, s.MovesPerSec, s.GamesPerSec, s.NodesPerSec)
	if *out == "" {
		_, err = os.Stdout.Write(data)
		return err
	}
	if d := filepath.Dir(*out); d != "" {
		os.MkdirAll(d, 0o755)
	}
	return os.WriteFile(*out, data, 0o644)
}

// agentConfig builds an agent config map from CLI flags.
func agentConfig(depth string, budget float64) (map[string]any, error) {
	cfg := map[string]any{}
	if depth != "" && depth != "auto" {
		n, err := strconv.Atoi(depth)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("--depth must be 'auto' or a positive integer")
		}
		cfg["depth"] = float64(n)
	}
	if budget > 0 {
		cfg["timeBudgetMs"] = budget
	}
	return cfg, nil
}

func cmdPlay(args []string) error {
	fs := flag.NewFlagSet("play", flag.ExitOnError)
	seedStr := fs.String("seed", "", "game seed (uint32; random if omitted)")
	agentID := fs.String("agent", "expectimax", "expectimax|random|greedy")
	depth := fs.String("depth", "auto", "search depth: auto or N")
	maxMoves := fs.Int("max-moves", 0, "stop after N moves (0 = to completion)")
	fs.Parse(args)
	seed := engine.RandomSeed()
	if *seedStr != "" {
		n, err := strconv.ParseUint(*seedStr, 10, 32)
		if err != nil {
			return fmt.Errorf("--seed must be a uint32")
		}
		seed = uint32(n)
	}
	cfg, err := agentConfig(*depth, 0)
	if err != nil {
		return err
	}
	agent, err := ai.NewAgent(*agentID, cfg)
	if err != nil {
		return err
	}
	pr, err := bench.Play(agent, seed, *maxMoves, nil)
	if err != nil {
		return err
	}
	out := struct {
		engine.Snapshot
		SpecVersion int     `json:"specVersion"`
		Agent       string  `json:"agent"`
		Nodes       int64   `json:"nodes"`
		WallMs      float64 `json:"wallMs"`
		Moves       string  `json:"moves"`
	}{pr.Game.Snapshot(), engine.SpecVersion, *agentID, pr.Nodes, pr.WallMs, pr.Game.Moves()}
	data, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(data))
	return nil
}
