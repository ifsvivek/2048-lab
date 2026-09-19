/* Benchmark-suite runner (spec/benchmarks) -> BenchmarkResult JSON
 * (spec/schemas/benchmark-result.schema.json). */
#ifndef G2048_BENCH_H
#define G2048_BENCH_H

#include <stdio.h>

#include "ai.h"
#include "json.h"

typedef struct {
    jval *doc; /* owns the parsed suite */
    const char *id;
    int spec_version;
    const char *agent_id;
    const jval *agent_config; /* NULL if absent */
    uint32_t seed_start;
    int seed_count;
    int max_moves;
    int time_decisions;
} suite_t;

/* Returns 0 on success (caller frees with suite_free), -1 on error. */
int suite_load(const char *path, suite_t *s, char *err, size_t errlen);
void suite_free(suite_t *s);
int suite_has_tag(const suite_t *s, const char *tag);

typedef struct {
    game_t game;
    int64_t nodes;
    double wall_ms;
} play_result_t;

typedef void (*decision_cb)(void *ctx, int64_t time_us);

/* Plays agent on seed until the game ends or max_moves (0 = unlimited).
 * Returns 0 on success (caller frees pr->game), -1 on error. */
int bench_play(agent_t *agent, uint32_t seed, int max_moves, decision_cb cb, void *ctx, play_result_t *pr,
               char *err, size_t errlen);

typedef struct {
    uint32_t seed;
    int64_t score, max_tile;
    int move_count, over;
    char history_hash[9];
    double wall_ms;
    int64_t nodes;
} game_result_t;

typedef struct {
    game_result_t *games;
    int n_games;
    int64_t total_moves, total_score, max_score;
    char checksum[9];
    jval *json; /* full BenchmarkResult */
    double wall_ms, moves_per_sec, games_per_sec, nodes_per_sec;
} bench_result_t;

/* Runs a suite. progress may be NULL. Returns 0 on success, -1 on error. */
int bench_run(const suite_t *suite, FILE *progress, bench_result_t *out, char *err, size_t errlen);
void bench_result_free(bench_result_t *r);

#endif
