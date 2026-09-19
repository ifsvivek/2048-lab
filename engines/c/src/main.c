/* g2048 — C port CLI: validate, bench, play. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "ai.h"
#include "bench.h"
#include "engine.h"
#include "json.h"
#include "validate.h"

static const char *USAGE =
    "usage: g2048 <command> [flags]\n"
    "\n"
    "commands:\n"
    "  validate [--fixtures DIR] [--json] [--skip-bench]   run every spec fixture check\n"
    "  bench --suite FILE [--out FILE]                      run a benchmark suite, emit BenchmarkResult JSON\n"
    "  play --seed N [--agent expectimax|random|greedy] [--depth auto|N] [--max-moves N]\n";

/* ---------- flag parsing (Go `flag` style: -x / --x, "=value" or next arg) ---------- */

typedef struct {
    const char *name;
    int is_bool;
    const char **value; /* string flags */
    int *flag;          /* bool flags */
} flag_def;

static void parse_flags(const char *cmd, int argc, char **argv, flag_def *defs, int ndefs) {
    for (int i = 0; i < argc; i++) {
        const char *a = argv[i];
        if (a[0] != '-' || a[1] == 0) break; /* first non-flag argument stops parsing */
        if (strcmp(a, "--") == 0) break;
        const char *name = a + (a[1] == '-' ? 2 : 1);
        const char *eq = strchr(name, '=');
        size_t nlen = eq ? (size_t)(eq - name) : strlen(name);
        if (strncmp(name, "h", nlen) == 0 && nlen == 1) goto help;
        if (strncmp(name, "help", nlen) == 0 && nlen == 4) goto help;
        flag_def *d = NULL;
        for (int k = 0; k < ndefs; k++)
            if (strlen(defs[k].name) == nlen && strncmp(defs[k].name, name, nlen) == 0) d = &defs[k];
        if (!d) {
            fprintf(stderr, "flag provided but not defined: -%.*s\n", (int)nlen, name);
            goto usage_err;
        }
        if (d->is_bool) {
            if (!eq || strcmp(eq + 1, "true") == 0 || strcmp(eq + 1, "1") == 0)
                *d->flag = 1;
            else if (strcmp(eq + 1, "false") == 0 || strcmp(eq + 1, "0") == 0)
                *d->flag = 0;
            else {
                fprintf(stderr, "invalid boolean value \"%s\" for -%s\n", eq + 1, d->name);
                goto usage_err;
            }
        } else if (eq) {
            *d->value = eq + 1;
        } else {
            if (i + 1 >= argc) {
                fprintf(stderr, "flag needs an argument: -%s\n", d->name);
                goto usage_err;
            }
            *d->value = argv[++i];
        }
    }
    return;
help:
    fprintf(stderr, "usage of %s:\n%s", cmd, USAGE);
    exit(0);
usage_err:
    fprintf(stderr, "%s", USAGE);
    exit(2);
}

static int is_dir(const char *p) {
    struct stat st;
    return stat(p, &st) == 0 && S_ISDIR(st.st_mode);
}

static const char *default_fixtures(void) {
    static const char *cands[] = {"../../spec/fixtures", "spec/fixtures", "../spec/fixtures",
                                  "../../../spec/fixtures"};
    for (size_t i = 0; i < sizeof cands / sizeof cands[0]; i++)
        if (is_dir(cands[i])) return cands[i];
    return "../../spec/fixtures";
}

/* ---------- validate ---------- */

static int cmd_validate(int argc, char **argv) {
    const char *dir = default_fixtures();
    int as_json = 0, skip = 0;
    flag_def defs[] = {{"fixtures", 0, &dir, NULL}, {"json", 1, NULL, &as_json}, {"skip-bench", 1, NULL, &skip}};
    parse_flags("validate", argc, argv, defs, 3);
    report_t r;
    report_init(&r);
    validate_all(&r, dir, skip);
    if (as_json) {
        jval *j = report_json(&r);
        sbuf out = {0};
        json_write(&out, j, -1);
        printf("%s\n", out.s);
        sb_free(&out);
        json_free(j);
    } else {
        printf("c engine %s \xe2\x80\x94 fixtures: %s\n", ENGINE_VERSION, dir);
        for (int i = 0; i < N_FIXTURES; i++) {
            if (!r.seen[i]) continue;
            printf("  %-16s %4d passed %4d failed  %s\n", FIXTURES[i], r.per_fixture[i][0], r.per_fixture[i][1],
                   r.per_fixture[i][1] > 0 ? "FAIL" : "ok");
        }
        for (size_t i = 0; i < r.n_failures; i++)
            printf("  FAIL %s [%s]: %s\n", r.failures[i].fixture, r.failures[i].name, r.failures[i].message);
        printf("%d passed, %d failed\n", r.passed, r.failed);
    }
    int failed = r.failed;
    report_free(&r);
    fflush(stdout);
    return failed > 0 ? 1 : 0;
}

/* ---------- bench ---------- */

static void mkdir_parents(const char *path) {
    char buf[4096];
    snprintf(buf, sizeof buf, "%s", path);
    char *slash = strrchr(buf, '/');
    if (!slash) return;
    *slash = 0;
    for (char *p = buf + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            mkdir(buf, 0755);
            *p = '/';
        }
    }
    mkdir(buf, 0755);
}

static int cmd_bench(int argc, char **argv) {
    const char *suite_path = "", *out_path = "";
    flag_def defs[] = {{"suite", 0, &suite_path, NULL}, {"out", 0, &out_path, NULL}};
    parse_flags("bench", argc, argv, defs, 2);
    if (!*suite_path) {
        fprintf(stderr, "error: --suite is required\n");
        return 1;
    }
    char err[1024];
    suite_t suite;
    if (suite_load(suite_path, &suite, err, sizeof err) != 0) {
        fprintf(stderr, "error: %s\n", err);
        return 1;
    }
    bench_result_t res;
    if (bench_run(&suite, stderr, &res, err, sizeof err) != 0) {
        fprintf(stderr, "error: %s\n", err);
        suite_free(&suite);
        return 1;
    }
    sbuf out = {0};
    json_write(&out, res.json, 2);
    sb_putc(&out, '\n');
    fprintf(stderr, "[%s] checksum=%s games=%d moves=%lld wall=%.0fms moves/s=%.0f games/s=%.2f nodes/s=%.0f\n",
            suite.id, res.checksum, res.n_games, (long long)res.total_moves, res.wall_ms, res.moves_per_sec,
            res.games_per_sec, res.nodes_per_sec);
    int rc = 0;
    if (!*out_path) {
        fwrite(out.s, 1, out.n, stdout);
    } else {
        mkdir_parents(out_path);
        FILE *f = fopen(out_path, "wb");
        if (!f || fwrite(out.s, 1, out.n, f) != out.n) {
            fprintf(stderr, "error: open %s: %s\n", out_path, strerror(errno));
            rc = 1;
        }
        if (f && fclose(f) != 0) rc = 1;
    }
    sb_free(&out);
    bench_result_free(&res);
    suite_free(&suite);
    return rc;
}

/* ---------- play ---------- */

static int cmd_play(int argc, char **argv) {
    const char *seed_s = "", *agent_id = "expectimax", *depth = "auto", *max_s = "0";
    flag_def defs[] = {{"seed", 0, &seed_s, NULL},
                       {"agent", 0, &agent_id, NULL},
                       {"depth", 0, &depth, NULL},
                       {"max-moves", 0, &max_s, NULL}};
    parse_flags("play", argc, argv, defs, 4);
    uint32_t seed = random_seed();
    if (*seed_s) {
        char *end;
        errno = 0;
        unsigned long long n = strtoull(seed_s, &end, 10);
        if (*end || errno || n > 0xFFFFFFFFull || seed_s[0] == '-' || seed_s[0] == '+') {
            fprintf(stderr, "error: --seed must be a uint32\n");
            return 1;
        }
        seed = (uint32_t)n;
    }
    char *end;
    long max_moves = strtol(max_s, &end, 10);
    if (*end) {
        fprintf(stderr, "invalid value \"%s\" for flag -max-moves: parse error\n%s", max_s, USAGE);
        return 2;
    }
    jval *cfg = jobject();
    if (*depth && strcmp(depth, "auto") != 0) {
        long n = strtol(depth, &end, 10);
        if (*end || n < 1) {
            fprintf(stderr, "error: --depth must be 'auto' or a positive integer\n");
            json_free(cfg);
            return 1;
        }
        jset(cfg, "depth", jint(n));
    }
    char err[512];
    agent_t *agent = agent_new(agent_id, cfg, err, sizeof err);
    json_free(cfg);
    if (!agent) {
        fprintf(stderr, "error: %s\n", err);
        return 1;
    }
    play_result_t pr;
    if (bench_play(agent, seed, (int)max_moves, NULL, NULL, &pr, err, sizeof err) != 0) {
        fprintf(stderr, "error: %s\n", err);
        agent_free(agent);
        return 1;
    }
    snapshot_t s;
    game_snapshot(&pr.game, &s);
    jval *o = jobject();
    jset(o, "seed", jint(s.seed));
    jset(o, "board", jstring(s.board));
    jset(o, "score", jint(s.score));
    jset(o, "moveCount", jint(s.move_count));
    jset(o, "maxTile", jint(s.max_tile));
    jset(o, "over", jbool(s.over));
    jset(o, "historyHash", jstring(s.history_hash));
    jset(o, "specVersion", jint(SPEC_VERSION));
    jset(o, "agent", jstring(agent_id));
    jset(o, "nodes", jint(pr.nodes));
    jset(o, "wallMs", jdouble(pr.wall_ms));
    jset(o, "moves", jstring(pr.game.moves));
    sbuf out = {0};
    json_write(&out, o, 2);
    printf("%s\n", out.s);
    sb_free(&out);
    json_free(o);
    game_free(&pr.game);
    agent_free(agent);
    return 0;
}

int main(int argc, char **argv) {
    engine_init();
    ai_init();
    if (argc < 2) {
        fputs(USAGE, stderr);
        return 2;
    }
    const char *cmd = argv[1];
    if (strcmp(cmd, "validate") == 0) return cmd_validate(argc - 2, argv + 2);
    if (strcmp(cmd, "bench") == 0) return cmd_bench(argc - 2, argv + 2);
    if (strcmp(cmd, "play") == 0) return cmd_play(argc - 2, argv + 2);
    if (strcmp(cmd, "-h") == 0 || strcmp(cmd, "--help") == 0 || strcmp(cmd, "help") == 0) {
        fputs(USAGE, stdout);
        return 0;
    }
    fprintf(stderr, "unknown command \"%s\"\n\n%s", cmd, USAGE);
    return 2;
}
