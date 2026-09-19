/* Canonical expectimax agent (spec/AI.md) and the reference random / greedy agents. */
#ifndef G2048_AI_H
#define G2048_AI_H

#include <stdint.h>

#include "engine.h"
#include "json.h"

typedef uint64_t bitboard_t;

void ai_init(void);

/* ---------- Bitboard (AI.md §1) ---------- */

uint16_t bb_column(bitboard_t b, int c);
/* Applies dir (saturating at rank 15); returns the new board (== b if invalid). */
bitboard_t bb_move(bitboard_t b, int dir);
bitboard_t bb_from_board(const board_t *board);
board_t bb_to_board(bitboard_t b);
int bb_distinct_ranks(bitboard_t b);

/* ---------- Heuristic (AI.md §2) ---------- */

typedef struct {
    int64_t lost, empty, merges, mono, sum, smooth, stable, corner;
} weights_t;

extern const weights_t HEURISTIC_V1;

typedef struct {
    int64_t empty, merges, mono, sum, smooth, stable;
} line_features_t;

line_features_t line_features(uint16_t v);
int64_t line_score(line_features_t f, const weights_t *w);
/* Memoised 65536-entry per-line score table. */
const double *line_table(const weights_t *w);
double corner_term(bitboard_t b, int64_t corner_weight);
double evaluate(bitboard_t b, const double *table, int64_t corner_weight);

typedef struct {
    line_features_t f;
    double corner, total;
} breakdown_t;
breakdown_t heuristic_breakdown(bitboard_t b, const weights_t *w);

/* ---------- Search (AI.md §3) ---------- */

typedef struct {
    int auto_depth;
    int depth, min_depth, max_depth;
    int four_prune_empties;
    double time_budget_ms; /* > 0: iterative deepening (non-deterministic) */
    int tt_bits;
    weights_t weights;
} ai_config_t;

ai_config_t canonical_config(void);
/* Overlays a JSON object (may be NULL) onto the canonical profile. Returns 0 or -1 (err filled). */
int parse_config(const jval *obj, ai_config_t *out, char *err, size_t errlen);

typedef struct {
    int move; /* -1 if no valid move */
    double value;
    double values[4];
    int has_value[4];
    int depth;
    int64_t nodes, tt_hits;
    int64_t tt_size;
    int64_t time_us;
    int deterministic;
    int completed[32];
    int n_completed;
} search_result_t;

typedef struct search search_t;

search_t *search_new(const ai_config_t *c);
void search_free(search_t *s);
const ai_config_t *search_config(const search_t *s);
int search_depth_for(const search_t *s, bitboard_t b);
void search_run(search_t *s, bitboard_t b, search_result_t *out);

/* ---------- Agents ---------- */

typedef enum { AGENT_RANDOM, AGENT_GREEDY, AGENT_EXPECTIMAX } agent_kind;

typedef struct {
    int move;
    int64_t time_us;
    int has_search; /* expectimax: the fields below are set */
    int64_t nodes;
    search_result_t result;
} decision_t;

typedef struct {
    agent_kind kind;
    const char *id;
    rng_t rng;        /* random */
    search_t *search; /* expectimax */
} agent_t;

/* id: "random" | "greedy" | "expectimax"; config: JSON object or NULL. Returns NULL on error. */
agent_t *agent_new(const char *id, const jval *config, char *err, size_t errlen);
void agent_free(agent_t *a);
void agent_reset(agent_t *a, uint32_t seed);
void agent_decide(agent_t *a, const board_t *board, decision_t *d);
int agent_is_deterministic(const agent_t *a);

/* Monotonic clock in nanoseconds. */
int64_t now_ns(void);
int64_t round_us(int64_t ns);

#endif
