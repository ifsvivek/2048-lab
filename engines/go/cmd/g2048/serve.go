package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"g2048/ai"
	"g2048/engine"
)

// agentRequest is the AGENT_PROTOCOL.md observation.
type agentRequest struct {
	GameID      string    `json:"gameId,omitempty"`
	Seed        *uint32   `json:"seed,omitempty"`
	SpecVersion *int      `json:"specVersion,omitempty"`
	Board       [][]int64 `json:"board,omitempty"`
	BoardHex    string    `json:"boardHex,omitempty"`
	Score       int64     `json:"score"`
	MoveCount   int       `json:"moveCount"`
	ValidMoves  []string  `json:"validMoves,omitempty"`
}

type agentResponse struct {
	Move    string     `json:"move"`
	Metrics ai.Metrics `json:"metrics"`
}

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", ":8080", "listen address")
	agentID := fs.String("agent", "expectimax", "expectimax|random|greedy")
	depth := fs.String("depth", "auto", "search depth: auto or N")
	budget := fs.Float64("time-budget-ms", 0, "iterative-deepening time budget (0 = deterministic)")
	fs.Parse(args)
	cfg, err := agentConfig(*depth, *budget)
	if err != nil {
		return err
	}
	agent, err := ai.NewAgent(*agentID, cfg)
	if err != nil {
		return err
	}
	log.Printf("g2048 (go) agent=%s listening on %s", agent.ID(), *addr)
	return http.ListenAndServe(*addr, newServer(agent))
}

// newServer returns the HTTP handler for /decide and /health.
func newServer(agent ai.Agent) http.Handler {
	var mu sync.Mutex // agents are stateful (TT, RNG) and not concurrency-safe
	var lastSeed *uint32

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "language": "go", "engineVersion": engine.EngineVersion,
			"specVersion": engine.SpecVersion, "agent": agent.ID(), "config": agent.ConfigJSON(),
		})
	})
	mux.HandleFunc("/decide", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
			return
		}
		var req agentRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		if err := dec.Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
			return
		}
		if req.SpecVersion != nil && *req.SpecVersion != engine.SpecVersion {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("unsupported specVersion %d", *req.SpecVersion)})
			return
		}
		var board engine.Board
		var err error
		switch {
		case req.BoardHex != "":
			board, err = engine.BoardFromHex(req.BoardHex)
		case req.Board != nil:
			board, err = engine.BoardFromMatrix(req.Board)
		default:
			err = fmt.Errorf("boardHex or board is required")
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if board.IsOver() {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "no valid moves"})
			return
		}
		mu.Lock()
		// Re-seed stateful agents (random) when a new game starts.
		if req.Seed != nil && (req.MoveCount == 0 || lastSeed == nil || *lastSeed != *req.Seed) {
			agent.Reset(*req.Seed)
			s := *req.Seed
			lastSeed = &s
		}
		t := time.Now()
		d := agent.Decide(&board)
		if d.Metrics.TimeUs == 0 {
			d.Metrics.TimeUs = time.Since(t).Microseconds()
		}
		mu.Unlock()
		writeJSON(w, http.StatusOK, agentResponse{Move: engine.DirectionNames[d.Move], Metrics: d.Metrics})
	})
	return cors(mux)
}

func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Access-Control-Allow-Origin", "*")
		hd.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		hd.Set("Access-Control-Allow-Headers", "*")
		hd.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
