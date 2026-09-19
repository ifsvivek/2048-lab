/* Fixture checks (spec/fixtures) shared by `g2048 validate`. */
#ifndef G2048_VALIDATE_H
#define G2048_VALIDATE_H

#include "json.h"

typedef struct {
    char *fixture, *name, *message;
} failure_t;

#define N_FIXTURES 9
extern const char *const FIXTURES[N_FIXTURES];

typedef struct {
    int passed, failed;
    failure_t *failures;
    size_t n_failures, cap;
    int per_fixture[N_FIXTURES][2]; /* passed, failed */
    int seen[N_FIXTURES];
} report_t;

void report_init(report_t *r);
void report_free(report_t *r);
/* Runs every fixture check against dir. */
void validate_all(report_t *r, const char *dir, int skip_benchmarks);
/* Builds the machine-readable report. */
jval *report_json(const report_t *r);

#endif
