#include "validate.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ai.h"
#include "bench.h"
#include "engine.h"

const char *const FIXTURES[N_FIXTURES] = {"rng.json",     "moves.json",   "spawn.json",
                                          "hash.json",    "games.json",   "replays.json",
                                          "codes.json",   "ai.json",      "benchmarks.json"};

static char *dupstr(const char *s) {
    size_t n = strlen(s);
    char *d = malloc(n + 1);
    if (!d) {
        fprintf(stderr, "out of memory\n");
        exit(1);
    }
    memcpy(d, s, n + 1);
    return d;
}

void report_init(report_t *r) { memset(r, 0, sizeof *r); }

void report_free(report_t *r) {
    for (size_t i = 0; i < r->n_failures; i++) {
        free(r->failures[i].fixture);
        free(r->failures[i].name);
        free(r->failures[i].message);
    }
    free(r->failures);
    memset(r, 0, sizeof *r);
}

static int fixture_index(const char *f) {
    for (int i = 0; i < N_FIXTURES; i++)
        if (strcmp(FIXTURES[i], f) == 0) return i;
    return -1;
}

static int vcheck(report_t *r, const char *fixture, const char *name, int ok, const char *fmt, va_list ap) {
    int fi = fixture_index(fixture);
    if (fi >= 0) r->seen[fi] = 1;
    if (ok) {
        r->passed++;
        if (fi >= 0) r->per_fixture[fi][0]++;
        return 1;
    }
    r->failed++;
    if (fi >= 0) r->per_fixture[fi][1]++;
    char msg[1024];
    vsnprintf(msg, sizeof msg, fmt, ap);
    if (r->n_failures == r->cap) {
        r->cap = r->cap ? r->cap * 2 : 16;
        r->failures = realloc(r->failures, r->cap * sizeof *r->failures);
        if (!r->failures) {
            fprintf(stderr, "out of memory\n");
            exit(1);
        }
    }
    failure_t *f = &r->failures[r->n_failures++];
    f->fixture = dupstr(fixture);
    f->name = dupstr(name);
    f->message = dupstr(msg);
    return 0;
}

#if defined(__GNUC__)
__attribute__((format(printf, 5, 6)))
#endif
static int check(report_t *r, const char *fixture, const char *name, int ok, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int res = vcheck(r, fixture, name, ok, fmt, ap);
    va_end(ap);
    return res;
}

#define fail(r, fixture, name, ...) check(r, fixture, name, 0, __VA_ARGS__)

static jval *load(const char *dir, const char *name, char *err, size_t errlen) {
    char path[4096];
    snprintf(path, sizeof path, "%s/%s", dir, name);
    return json_load(path, err, errlen);
}

/* ---------- small JSON accessors ---------- */

static int64_t geti(const jval *o, const char *k) { return (int64_t)json_num(json_get(o, k), 0); }
static const char *gets_(const jval *o, const char *k) {
    const char *s = json_str(json_get(o, k));
    return s ? s : "";
}
static int getb(const jval *o, const char *k) {
    const jval *v = json_get(o, k);
    return v && v->t == J_BOOL && v->b;
}
static size_t len(const jval *a) { return a && (a->t == J_ARR || a->t == J_OBJ) ? a->n : 0; }

static void get_state(const jval *arr, uint32_t out[4]) {
    for (size_t i = 0; i < 4; i++) out[i] = (uint32_t)json_num(json_at(arr, i), 0);
}

static int state_eq(const uint32_t a[4], const uint32_t b[4]) { return memcmp(a, b, 4 * sizeof(uint32_t)) == 0; }

static void fmt_state(const uint32_t s[4], char *out, size_t n) {
    snprintf(out, n, "[%u %u %u %u]", s[0], s[1], s[2], s[3]);
}

static board_t must_board(const char *hex) {
    board_t b;
    if (board_from_hex(hex, &b, NULL, 0) != 0) memset(&b, 0, sizeof b);
    return b;
}

/* ---------- rng.json ---------- */

static void check_rng(report_t *r, const jval *fx) {
    const jval *cases = json_get(fx, "cases");
    for (size_t ci = 0; ci < len(cases); ci++) {
        const jval *c = cases->items[ci];
        uint32_t seed = (uint32_t)geti(c, "seed");
        char id[64], name[128], s1[80], s2[80];
        snprintf(id, sizeof id, "seed=%u", seed);
        uint32_t st[4], want[4];
        mix32(seed, st);
        get_state(json_get(c, "state"), want);
        fmt_state(st, s1, sizeof s1);
        fmt_state(want, s2, sizeof s2);
        snprintf(name, sizeof name, "%s state", id);
        check(r, "rng.json", name, state_eq(st, want), "state %s, want %s", s1, s2);

        rng_t g;
        memcpy(g.s, st, sizeof st);
        const jval *next = json_get(c, "next");
        int ok = 1;
        snprintf(name, sizeof name, "%s next", id);
        for (size_t i = 0; i < len(next); i++) {
            uint32_t w = (uint32_t)json_num(next->items[i], 0), got = rng_next(&g);
            if (got != w) {
                fail(r, "rng.json", name, "next[%zu]=%u, want %u", i, got, w);
                ok = 0;
                break;
            }
        }
        if (ok) check(r, "rng.json", name, 1, "%s", "");

        const jval *below = json_get(c, "below");
        for (size_t bi = 0; below && below->t == J_OBJ && bi < below->n; bi++) {
            const char *ns = below->keys[bi];
            const jval *seq = below->items[bi];
            uint64_t n = strtoull(ns, NULL, 10);
            rng_t g2;
            rng_seed(&g2, seed);
            snprintf(name, sizeof name, "%s below(%s)", id, ns);
            ok = 1;
            for (size_t i = 0; i < len(seq); i++) {
                uint32_t w = (uint32_t)json_num(seq->items[i], 0), got = rng_below(&g2, n);
                if (got != w) {
                    fail(r, "rng.json", name, "below[%zu]=%u, want %u", i, got, w);
                    ok = 0;
                    break;
                }
            }
            if (ok) check(r, "rng.json", name, 1, "%s", "");
        }
    }
}

/* ---------- moves.json ---------- */

static void check_moves(report_t *r, const jval *fx) {
    const jval *cases = json_get(fx, "cases");
    for (size_t ci = 0; ci < len(cases); ci++) {
        const jval *c = cases->items[ci];
        const char *hex = gets_(c, "board");
        board_t b;
        char err[128];
        if (board_from_hex(hex, &b, err, sizeof err) != 0) {
            fail(r, "moves.json", hex, "%s", err);
            continue;
        }
        const jval *results = json_get(c, "results");
        for (size_t ri = 0; ri < len(results); ri++) {
            const jval *res = results->items[ri];
            const char *dir_s = gets_(res, "dir");
            int d = parse_direction(dir_s);
            char id[64];
            snprintf(id, sizeof id, "%s %s", hex, dir_s);
            if (d < 0) {
                fail(r, "moves.json", id, "invalid direction '%s'", dir_s);
                continue;
            }
            board_t nb = b;
            int64_t g = board_move(&nb, d);
            int changed = g >= 0;
            if (!changed) {
                nb = b;
                g = 0;
            }
            char out[17];
            board_hex(&nb, out);
            int can = board_can_move(&b, d);
            int ok = strcmp(out, gets_(res, "board")) == 0 && g == geti(res, "gained") &&
                     changed == getb(res, "changed") && can == changed;
            check(r, "moves.json", id, ok, "got board=%s gained=%lld changed=%d canMove=%d, want %s %lld %d", out,
                  (long long)g, changed, can, gets_(res, "board"), (long long)geti(res, "gained"),
                  getb(res, "changed"));
        }
        char id[64];
        snprintf(id, sizeof id, "%s over", hex);
        check(r, "moves.json", id, board_is_over(&b) == getb(c, "over"), "over=%d, want %d", board_is_over(&b),
              getb(c, "over"));
    }
}

/* ---------- spawn.json ---------- */

static void check_spawn(report_t *r, const jval *fx) {
    const jval *cases = json_get(fx, "cases");
    for (size_t ci = 0; ci < len(cases); ci++) {
        const jval *c = cases->items[ci];
        board_t b = must_board(gets_(c, "board"));
        rng_t g;
        get_state(json_get(c, "rngState"), g.s);
        int idx = 0;
        uint8_t e = 0;
        int ok = board_spawn(&b, &g, &idx, &e);
        char out[17], s1[80];
        board_hex(&b, out);
        uint32_t after[4];
        get_state(json_get(c, "rngStateAfter"), after);
        const jval *sp = json_get(c, "spawn");
        int want_spawn = !json_is_null(sp);
        int good = strcmp(out, gets_(c, "result")) == 0 && state_eq(g.s, after) && ok == want_spawn;
        if (good && ok) good = idx == geti(sp, "index") && e == geti(sp, "exponent");
        char name[64];
        snprintf(name, sizeof name, "#%zu %s", ci, gets_(c, "board"));
        fmt_state(g.s, s1, sizeof s1);
        check(r, "spawn.json", name, good, "got %s idx=%d exp=%u ok=%d state=%s", out, idx, e, ok, s1);
    }
}

/* ---------- hash.json ---------- */

static void check_hash(report_t *r, const jval *fx) {
    const jval *cases = json_get(fx, "cases");
    for (size_t ci = 0; ci < len(cases); ci++) {
        const jval *c = cases->items[ci];
        board_t b = must_board(gets_(c, "board"));
        char bh[9], hs[9];
        hash_hex(board_hash(&b), bh);
        uint32_t prev = (uint32_t)strtoul(gets_(c, "prev"), NULL, 16);
        hash_hex(history_step(prev, &b, (int)geti(c, "dir")), hs);
        check(r, "hash.json", gets_(c, "board"),
              strcmp(bh, gets_(c, "boardHash")) == 0 && strcmp(hs, gets_(c, "historyStep")) == 0,
              "boardHash=%s historyStep=%s, want %s %s", bh, hs, gets_(c, "boardHash"), gets_(c, "historyStep"));
    }
}

/* ---------- games.json ---------- */

static int same_final(const snapshot_t *s, const jval *f) {
    return strcmp(s->board, gets_(f, "board")) == 0 && s->score == geti(f, "score") &&
           s->move_count == geti(f, "moveCount") && s->max_tile == geti(f, "maxTile") && s->over == getb(f, "over") &&
           strcmp(s->history_hash, gets_(f, "historyHash")) == 0;
}

static void fmt_snapshot(const snapshot_t *s, char *out, size_t n) {
    snprintf(out, n, "{board:%s score:%lld moveCount:%d maxTile:%lld over:%d historyHash:%s}", s->board,
             (long long)s->score, s->move_count, (long long)s->max_tile, s->over, s->history_hash);
}

static void check_games(report_t *r, const jval *fx) {
    const jval *ng = json_get(fx, "newGames");
    for (size_t i = 0; i < len(ng); i++) {
        const jval *c = ng->items[i];
        uint32_t seed = (uint32_t)geti(c, "seed");
        game_t g;
        game_init(&g, seed);
        char hex[17], hh[9], st[80], name[64];
        board_hex(&g.board, hex);
        hash_hex(g.hash, hh);
        uint32_t want[4];
        get_state(json_get(c, "rngState"), want);
        fmt_state(g.rng.s, st, sizeof st);
        snprintf(name, sizeof name, "newGame seed=%u", seed);
        check(r, "games.json", name,
              strcmp(hex, gets_(c, "board")) == 0 && state_eq(g.rng.s, want) &&
                  strcmp(hh, gets_(c, "historyHash")) == 0,
              "board=%s rng=%s hash=%s", hex, st, hh);
        game_free(&g);
    }
    const jval *games = json_get(fx, "games");
    for (size_t i = 0; i < len(games); i++) {
        const jval *c = games->items[i];
        uint32_t seed = (uint32_t)geti(c, "seed");
        const char *agent_s = gets_(c, "agent");
        const char *moves = gets_(c, "moves");
        const jval *final = json_get(c, "final");
        char id[128], name[160], snap_s[256];
        snprintf(id, sizeof id, "game seed=%u agent=%s", seed, agent_s);
        snprintf(name, sizeof name, "%s replay", id);
        game_t g;
        replay_err_t err;
        if (simulate(seed, moves, &g, &err) != 0) {
            fail(r, "games.json", name, "%s", err.message);
        } else {
            snapshot_t s;
            game_snapshot(&g, &s);
            fmt_snapshot(&s, snap_s, sizeof snap_s);
            check(r, "games.json", name, same_final(&s, final), "final %s mismatch", snap_s);
            game_free(&g);
        }
        agent_t *agent = NULL;
        char aerr[256];
        if (strcmp(agent_s, "random") == 0) {
            agent = agent_new("random", NULL, aerr, sizeof aerr);
        } else if (strcmp(agent_s, "expectimax-d2") == 0) {
            jval *cfg = jset(jobject(), "depth", jint(2));
            agent = agent_new("expectimax", cfg, aerr, sizeof aerr);
            json_free(cfg);
        } else {
            continue;
        }
        /* Random games run to completion; expectimax-d2 games were generated
         * with maxMoves=1500, so cap at the recorded length when not over. */
        int limit = getb(final, "over") ? 0 : (int)strlen(moves);
        play_result_t pr;
        snprintf(name, sizeof name, "%s agent", id);
        if (!agent) {
            fail(r, "games.json", name, "%s", aerr);
            continue;
        }
        if (bench_play(agent, seed, limit, NULL, NULL, &pr, aerr, sizeof aerr) != 0) {
            fail(r, "games.json", name, "%s", aerr);
            agent_free(agent);
            continue;
        }
        snapshot_t s;
        game_snapshot(&pr.game, &s);
        check(r, "games.json", name, strcmp(pr.game.moves, moves) == 0 && same_final(&s, final),
              "agent replay diverged (moves %zu vs %zu)", strlen(pr.game.moves), strlen(moves));
        game_free(&pr.game);
        agent_free(agent);
    }
}

/* ---------- replays.json ---------- */

static void check_replays(report_t *r, const jval *fx) {
    const jval *cases = json_get(fx, "cases");
    for (size_t ci = 0; ci < len(cases); ci++) {
        const jval *c = cases->items[ci];
        const char *name = gets_(c, "name");
        uint32_t seed = (uint32_t)geti(c, "seed");
        const char *moves = gets_(c, "moves");
        const jval *expect = json_get(c, "expect");
        snapshot_t snap;
        replay_err_t err;
        int rc = verify_replay(1, seed, moves, NULL, &snap, &err);
        char n2[160], snap_s[256];
        if (getb(expect, "ok")) {
            const jval *f = json_get(expect, "final");
            int ok = rc == 0 && same_final(&snap, f);
            fmt_snapshot(&snap, snap_s, sizeof snap_s);
            check(r, "replays.json", name, ok, "err=%s final=%s", rc ? err.message : "<nil>", snap_s);
            if (ok) {
                /* a correct claim verifies and a wrong claim is rejected */
                int64_t score = geti(f, "score");
                int mc = (int)geti(f, "moveCount");
                final_claim_t claim = {gets_(f, "board"), &score, &mc, gets_(f, "historyHash")};
                snprintf(n2, sizeof n2, "%s claim", name);
                rc = verify_replay(1, seed, moves, &claim, &snap, &err);
                check(r, "replays.json", n2, rc == 0, "valid claim rejected: %s", rc ? err.message : "");
                int64_t bad = score + 4;
                final_claim_t badc = {NULL, &bad, NULL, NULL};
                rc = verify_replay(1, seed, moves, &badc, &snap, &err);
                snprintf(n2, sizeof n2, "%s bad-claim", name);
                check(r, "replays.json", n2, rc != 0 && strcmp(err.code, "FINAL_MISMATCH") == 0,
                      "want FINAL_MISMATCH, got %s", rc ? err.message : "<nil>");
                rc = verify_replay(2, seed, moves, NULL, &snap, &err);
                snprintf(n2, sizeof n2, "%s spec-version", name);
                check(r, "replays.json", n2, rc != 0 && strcmp(err.code, "SPEC_VERSION") == 0,
                      "want SPEC_VERSION, got %s", rc ? err.message : "<nil>");
            }
            continue;
        }
        const char *want = gets_(expect, "error");
        int ok = rc != 0 && strcmp(err.code, want) == 0;
        const jval *mi = json_get(expect, "moveIndex");
        if (ok && !json_is_null(mi)) ok = err.move_index == (int)json_num(mi, -1);
        check(r, "replays.json", name, ok, "got %s, want %s at %d", rc ? err.message : "<nil>", want,
              json_is_null(mi) ? -1 : (int)json_num(mi, -1));
    }
}

/* ---------- codes.json ---------- */

static void check_codes(report_t *r, const jval *fx) {
    check(r, "codes.json", "alphabet", strcmp(gets_(fx, "alphabet"), REPLAY_ALPHABET) == 0, "alphabet mismatch");
    const jval *cases = json_get(fx, "cases");
    for (size_t ci = 0; ci < len(cases); ci++) {
        const jval *c = cases->items[ci];
        const char *input = gets_(c, "input");
        char n[13] = {0}, f[15];
        int ok = normalize_replay_code(input, n);
        const char *wn = json_str(json_get(c, "normalized"));
        const char *wf = json_str(json_get(c, "formatted"));
        int good;
        if (!wn) {
            good = !ok;
        } else {
            good = ok && strcmp(n, wn) == 0 && wf != NULL;
            if (good) {
                format_replay_code(n, f);
                good = strcmp(f, wf) == 0;
            }
        }
        check(r, "codes.json", input, good, "normalized=\"%s\" ok=%d", ok ? n : "", ok);
    }
}

/* ---------- ai.json ---------- */

static weights_t parse_weights(const jval *o) {
    weights_t w = {geti(o, "lost"),   geti(o, "empty"),  geti(o, "merges"), geti(o, "mono"),
                   geti(o, "sum"),    geti(o, "smooth"), geti(o, "stable"), geti(o, "corner")};
    return w;
}

static int rel_close(double a, double b) {
    if (a == b) return 1;
    return fabs(a - b) <= 1e-9 * fmax(fabs(a), fabs(b));
}

typedef struct {
    char *key;
    search_t *s;
} searcher_entry;

static void check_ai(report_t *r, const jval *fx) {
    const char *F = "ai.json";
    const jval *wj = json_get(fx, "weights");
    weights_t wc = parse_weights(json_get(wj, "canonical"));
    weights_t wa = parse_weights(json_get(wj, "allWeights"));
    check(r, F, "canonical weights", memcmp(&wc, &HEURISTIC_V1, sizeof wc) == 0, "canonical weights mismatch");
    const double *tc = line_table(&wc), *ta = line_table(&wa);
    char id[160], num1[64], num2[64];

    const jval *lines = json_get(fx, "lines");
    for (size_t i = 0; i < len(lines); i++) {
        const jval *l = lines->items[i];
        uint16_t line = (uint16_t)geti(l, "line");
        line_features_t f = line_features(line);
        const jval *wf = json_get(l, "features");
        int ok = f.empty == geti(wf, "empty") && f.merges == geti(wf, "merges") && f.mono == geti(wf, "mono") &&
                 f.sum == geti(wf, "sum") && f.smooth == geti(wf, "smooth") && f.stable == geti(wf, "stable") &&
                 tc[line] == json_num(json_get(l, "canonical"), NAN) &&
                 ta[line] == json_num(json_get(l, "allWeights"), NAN);
        snprintf(id, sizeof id, "line %u", line);
        json_fmt_double(tc[line], num1, sizeof num1);
        json_fmt_double(ta[line], num2, sizeof num2);
        check(r, F, id, ok, "features {empty:%lld merges:%lld mono:%lld sum:%lld smooth:%lld stable:%lld} "
                            "canonical=%s allWeights=%s",
              (long long)f.empty, (long long)f.merges, (long long)f.mono, (long long)f.sum, (long long)f.smooth,
              (long long)f.stable, num1, num2);
    }

    const jval *evals = json_get(fx, "evaluations");
    for (size_t i = 0; i < len(evals); i++) {
        const jval *e = evals->items[i];
        board_t b = must_board(gets_(e, "board"));
        bitboard_t bb = bb_from_board(&b);
        double vc = evaluate(bb, tc, wc.corner), va = evaluate(bb, ta, wa.corner);
        snprintf(id, sizeof id, "eval %s", gets_(e, "board"));
        json_fmt_double(vc, num1, sizeof num1);
        json_fmt_double(va, num2, sizeof num2);
        check(r, F, id,
              vc == json_num(json_get(e, "canonical"), NAN) && va == json_num(json_get(e, "allWeights"), NAN),
              "canonical=%s allWeights=%s", num1, num2);
    }

    const jval *bbm = json_get(fx, "bitboardMoves");
    for (size_t i = 0; i < len(bbm); i++) {
        const jval *m = bbm->items[i];
        board_t b = must_board(gets_(m, "board"));
        bitboard_t bb = bb_from_board(&b);
        const jval *results = json_get(m, "results");
        for (size_t d = 0; d < len(results) && d < 4; d++) {
            const jval *res = results->items[d];
            bitboard_t nb = bb_move(bb, (int)d);
            int ch = nb != bb;
            board_t ob = bb_to_board(nb);
            char out[17];
            board_hex(&ob, out);
            snprintf(id, sizeof id, "bbmove %s %c", gets_(m, "board"), DIRECTION_LETTERS[d]);
            check(r, F, id, strcmp(out, gets_(res, "board")) == 0 && ch == getb(res, "changed"),
                  "got %s %d, want %s %d", out, ch, gets_(res, "board"), getb(res, "changed"));
        }
    }

    searcher_entry *cache = NULL;
    size_t n_cache = 0;
    const jval *searches = json_get(fx, "searches");
    for (size_t i = 0; i < len(searches); i++) {
        const jval *sj = searches->items[i];
        snprintf(id, sizeof id, "search %s %s", gets_(sj, "profile"), gets_(sj, "board"));
        const jval *cfg = json_get(sj, "config");
        sbuf key = {0};
        if (cfg)
            json_write(&key, cfg, -1);
        else
            sb_puts(&key, "null");
        search_t *srch = NULL;
        for (size_t k = 0; k < n_cache; k++)
            if (strcmp(cache[k].key, key.s) == 0) srch = cache[k].s;
        if (!srch) {
            ai_config_t c;
            char err[256];
            if (parse_config(cfg, &c, err, sizeof err) != 0) {
                fail(r, F, id, "config: %s", err);
                sb_free(&key);
                continue;
            }
            c.tt_bits = 18;
            srch = search_new(&c);
            cache = realloc(cache, (n_cache + 1) * sizeof *cache);
            cache[n_cache].key = dupstr(key.s);
            cache[n_cache].s = srch;
            n_cache++;
        }
        sb_free(&key);
        board_t b = must_board(gets_(sj, "board"));
        search_result_t res;
        search_run(srch, bb_from_board(&b), &res);
        char move[8] = "null";
        if (res.move >= 0) snprintf(move, sizeof move, "%c", DIRECTION_LETTERS[res.move]);
        const char *want = json_str(json_get(sj, "move"));
        if (!want) want = "null";
        const jval *values = json_get(sj, "values");
        int ok = strcmp(move, want) == 0 && res.depth == geti(sj, "depth") && len(values) == 4;
        char msg[256];
        snprintf(msg, sizeof msg, "move=%s depth=%d, want %s %lld", move, res.depth, want,
                 (long long)geti(sj, "depth"));
        for (int d = 0; ok && d < 4; d++) {
            const jval *exp = values->items[d];
            int exp_null = json_is_null(exp);
            if (res.has_value[d] == exp_null) {
                ok = 0;
                snprintf(msg, sizeof msg, "values[%d] null mismatch", d);
            } else if (res.has_value[d] && !rel_close(res.values[d], exp->num)) {
                ok = 0;
                json_fmt_double(res.values[d], num1, sizeof num1);
                json_fmt_double(exp->num, num2, sizeof num2);
                snprintf(msg, sizeof msg, "values[%d]=%s, want %s", d, num1, num2);
            }
        }
        check(r, F, id, ok, "%s", msg);
    }
    for (size_t k = 0; k < n_cache; k++) {
        free(cache[k].key);
        search_free(cache[k].s);
    }
    free(cache);
}

/* ---------- benchmarks.json ---------- */

static int cmp_str(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static void check_benchmarks(report_t *r, const jval *fx, const char *dir) {
    const char *F = "benchmarks.json";
    const jval *suites = json_get(fx, "suites");
    size_t n = suites && suites->t == J_OBJ ? suites->n : 0;
    char **ids = malloc((n ? n : 1) * sizeof *ids);
    for (size_t i = 0; i < n; i++) ids[i] = suites->keys[i];
    qsort(ids, n, sizeof *ids, cmp_str);
    for (size_t i = 0; i < n; i++) {
        const char *id = ids[i];
        const jval *want = json_get(suites, id);
        char path[4096], err[512];
        snprintf(path, sizeof path, "%s/../benchmarks/%s.json", dir, id);
        suite_t suite;
        if (suite_load(path, &suite, err, sizeof err) != 0) {
            fail(r, F, id, "%s", err);
            continue;
        }
        if (suite_has_tag(&suite, "heavy")) {
            suite_free(&suite);
            continue;
        }
        bench_result_t res;
        if (bench_run(&suite, NULL, &res, err, sizeof err) != 0) {
            fail(r, F, id, "%s", err);
            suite_free(&suite);
            continue;
        }
        check(r, F, id,
              strcmp(res.checksum, gets_(want, "checksum")) == 0 && res.n_games == geti(want, "games") &&
                  res.total_moves == geti(want, "totalMoves") && res.total_score == geti(want, "totalScore") &&
                  res.max_score == geti(want, "maxScore"),
              "checksum=%s games=%d totalMoves=%lld totalScore=%lld maxScore=%lld, want %s %lld %lld %lld %lld",
              res.checksum, res.n_games, (long long)res.total_moves, (long long)res.total_score,
              (long long)res.max_score, gets_(want, "checksum"), (long long)geti(want, "games"),
              (long long)geti(want, "totalMoves"), (long long)geti(want, "totalScore"),
              (long long)geti(want, "maxScore"));
        bench_result_free(&res);
        suite_free(&suite);
    }
    free(ids);
}

/* ---------- driver ---------- */

static void run_one(report_t *r, const char *dir, const char *name) {
    char err[512];
    jval *fx = load(dir, name, err, sizeof err);
    if (!fx) {
        fail(r, name, "load", "%s", err);
        return;
    }
    if (strcmp(name, "rng.json") == 0) check_rng(r, fx);
    else if (strcmp(name, "moves.json") == 0) check_moves(r, fx);
    else if (strcmp(name, "spawn.json") == 0) check_spawn(r, fx);
    else if (strcmp(name, "hash.json") == 0) check_hash(r, fx);
    else if (strcmp(name, "games.json") == 0) check_games(r, fx);
    else if (strcmp(name, "replays.json") == 0) check_replays(r, fx);
    else if (strcmp(name, "codes.json") == 0) check_codes(r, fx);
    else if (strcmp(name, "ai.json") == 0) check_ai(r, fx);
    else if (strcmp(name, "benchmarks.json") == 0) check_benchmarks(r, fx, dir);
    else fail(r, name, "load", "unknown fixture");
    json_free(fx);
}

void validate_all(report_t *r, const char *dir, int skip_benchmarks) {
    for (int i = 0; i < N_FIXTURES; i++) {
        if (skip_benchmarks && strcmp(FIXTURES[i], "benchmarks.json") == 0) continue;
        run_one(r, dir, FIXTURES[i]);
    }
}

jval *report_json(const report_t *r) {
    jval *o = jobject();
    jset(o, "language", jstring("c"));
    jset(o, "engineVersion", jstring(ENGINE_VERSION));
    jset(o, "passed", jint(r->passed));
    jset(o, "failed", jint(r->failed));
    jval *fs = jarray();
    for (size_t i = 0; i < r->n_failures; i++) {
        jval *f = jobject();
        jset(f, "fixture", jstring(r->failures[i].fixture));
        jset(f, "case", jstring(r->failures[i].name));
        jset(f, "message", jstring(r->failures[i].message));
        jpush(fs, f);
    }
    jset(o, "failures", fs);
    return o;
}
