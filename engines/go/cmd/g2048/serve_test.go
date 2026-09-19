package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"g2048/ai"
)

func TestDecide(t *testing.T) {
	agent, _ := ai.NewAgent("expectimax", map[string]any{"depth": 2.0})
	h := newServer(agent)
	for _, body := range []string{
		`{"seed":1,"specVersion":1,"boardHex":"0100002000001000","score":0,"moveCount":0}`,
		`{"seed":1,"specVersion":1,"board":[[0,2,0,0],[0,0,4,0],[0,0,0,0],[2,0,0,0]],"score":0,"moveCount":0}`,
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/decide", strings.NewReader(body)))
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body)
		}
		if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Error("missing CORS header")
		}
		var resp struct {
			Move    string         `json:"move"`
			Metrics map[string]any `json:"metrics"`
		}
		json.Unmarshal(rec.Body.Bytes(), &resp)
		if resp.Move == "" || resp.Metrics["nodes"] == nil || resp.Metrics["depth"].(float64) != 2 {
			t.Fatalf("bad response %s", rec.Body)
		}
		vals := resp.Metrics["values"].([]any)
		if len(vals) != 4 {
			t.Fatal("values must have 4 entries")
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/decide", strings.NewReader(`{"boardHex":"zz"}`)))
	if rec.Code != 400 {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != 200 {
		t.Fatalf("health %d", rec.Code)
	}
}
