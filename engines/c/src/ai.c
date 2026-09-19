#include "ai.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ---------- time ---------- */

int64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

int64_t round_us(int64_t ns) { return (int64_t)llround((double)ns / 1000.0); }

/* ---------- bitboard ---------- */

/* line_low slides toward the low nibble ("left" for rows, "up" for columns). */
static uint16_t line_low[65536];
/* line_high slides toward the high nibble ("right" / "down"). */
static uint16_t line_high[65536];
/* spread_col places a line value as column 0 (nibble k -> row k). */
static uint64_t spread_col[65536];

static uint16_t reverse_line(uint16_t v) {
    return (uint16_t)((v & 0xf) << 12 | ((v >> 4) & 0xf) << 8 | ((v >> 8) & 0xf) << 4 | ((v >> 12) & 0xf));
}

void ai_init(void) {
    for (unsigned v = 0; v < 65536; v++) {
        uint16_t r[4], tiles[4], out[4] = {0, 0, 0, 0};
        int n = 0, o = 0;
        for (int k = 0; k < 4; k++) {
            r[k] = (uint16_t)((v >> (4 * k)) & 0xf);
            if (r[k]) tiles[n++] = r[k];
        }
        for (int i = 0; i < n; i++) {
            if (i + 1 < n && tiles[i] == tiles[i + 1]) {
                out[o] = tiles[i] + 1 > 15 ? 15 : (uint16_t)(tiles[i] + 1);
                i++;
            } else {
                out[o] = tiles[i];
            }
            o++;
        }
        line_low[v] = (uint16_t)(out[0] | out[1] << 4 | out[2] << 8 | out[3] << 12);
        spread_col[v] = (uint64_t)r[0] | (uint64_t)r[1] << 16 | (uint64_t)r[2] << 32 | (uint64_t)r[3] << 48;
    }
    for (unsigned v = 0; v < 65536; v++) line_high[v] = reverse_line(line_low[reverse_line((uint16_t)v)]);
}

uint16_t bb_column(bitboard_t b, int c) {
    uint64_t x = b >> (4 * c);
    return (uint16_t)((x & 0xf) | ((x >> 16) & 0xf) << 4 | ((x >> 32) & 0xf) << 8 | ((x >> 48) & 0xf) << 12);
}

bitboard_t bb_move(bitboard_t b, int dir) {
    const uint16_t *t;
    switch (dir) {
    case DIR_LEFT:
    case DIR_RIGHT:
        t = dir == DIR_RIGHT ? line_high : line_low;
        return (uint64_t)t[(uint16_t)b] | (uint64_t)t[(uint16_t)(b >> 16)] << 16 |
               (uint64_t)t[(uint16_t)(b >> 32)] << 32 | (uint64_t)t[(uint16_t)(b >> 48)] << 48;
    default:
        t = dir == DIR_DOWN ? line_high : line_low;
        return spread_col[t[bb_column(b, 0)]] | spread_col[t[bb_column(b, 1)]] << 4 |
               spread_col[t[bb_column(b, 2)]] << 8 | spread_col[t[bb_column(b, 3)]] << 12;
    }
}

bitboard_t bb_from_board(const board_t *board) {
    bitboard_t b = 0;
    for (int i = 0; i < 16; i++) b |= (uint64_t)(board->c[i] > 15 ? 15 : board->c[i]) << (4 * i);
    return b;
}

board_t bb_to_board(bitboard_t b) {
    board_t out;
    for (int i = 0; i < 16; i++) out.c[i] = (uint8_t)((b >> (4 * i)) & 0xf);
    return out;
}

int bb_distinct_ranks(bitboard_t b) {
    uint32_t mask = 0;
    for (int i = 0; i < 16; i++) mask |= 1u << ((b >> (4 * i)) & 0xf);
    mask &= ~1u;
    int n = 0;
    while (mask) {
        mask &= mask - 1;
        n++;
    }
    return n;
}

static inline int count_empty(bitboard_t b) {
    uint64_t x = b | (b >> 1);
    x |= x >> 2;
    x &= 0x1111111111111111ull;
    return 16 - __builtin_popcountll(x);
}

/* ---------- heuristic ---------- */

const weights_t HEURISTIC_V1 = {200000, 270, 700, 47, 11, 0, 0, 0};

line_features_t line_features(uint16_t v) {
    int64_t r[4] = {v & 0xf, (v >> 4) & 0xf, (v >> 8) & 0xf, (v >> 12) & 0xf};
    line_features_t f = {0, 0, 0, 0, 0, 0};
    int64_t prev = 0, counter = 0;
    for (int i = 0; i < 4; i++) {
        int64_t rank = r[i];
        f.sum += rank * rank * rank;
        if (rank == 0) {
            f.empty++;
            continue;
        }
        if (prev == rank) {
            counter++;
        } else if (counter > 0) {
            f.merges += 1 + counter;
            counter = 0;
        }
        prev = rank;
    }
    if (counter > 0) f.merges += 1 + counter;
    int64_t mono_l = 0, mono_r = 0;
    for (int i = 1; i < 4; i++) {
        int64_t a = r[i - 1] * r[i - 1] * r[i - 1] * r[i - 1];
        int64_t b = r[i] * r[i] * r[i] * r[i];
        if (r[i - 1] > r[i])
            mono_l += a - b;
        else
            mono_r += b - a;
        if (r[i - 1] != 0 && r[i] != 0) {
            int64_t d = r[i - 1] - r[i];
            f.smooth += d < 0 ? -d : d;
        }
    }
    if (f.empty == 0 && (mono_l == 0 || mono_r == 0)) f.stable = 1;
    f.mono = mono_l < mono_r ? mono_l : mono_r;
    return f;
}

int64_t line_score(line_features_t f, const weights_t *w) {
    return w->lost + w->empty * f.empty + w->merges * f.merges - w->mono * f.mono - w->sum * f.sum -
           w->smooth * f.smooth + w->stable * f.stable;
}

#define MAX_TABLES 16
static struct {
    weights_t w;
    double *t;
} table_cache[MAX_TABLES];
static int n_tables;

const double *line_table(const weights_t *w) {
    for (int i = 0; i < n_tables; i++)
        if (memcmp(&table_cache[i].w, w, sizeof *w) == 0) return table_cache[i].t;
    double *t = malloc(65536 * sizeof *t);
    if (!t) {
        fprintf(stderr, "out of memory\n");
        exit(1);
    }
    for (unsigned v = 0; v < 65536; v++) t[v] = (double)line_score(line_features((uint16_t)v), w);
    if (n_tables < MAX_TABLES) {
        table_cache[n_tables].w = *w;
        table_cache[n_tables].t = t;
        n_tables++;
    }
    return t;
}

double corner_term(bitboard_t b, int64_t corner_weight) {
    if (corner_weight == 0) return 0;
    uint64_t mx = 0;
    for (int i = 0; i < 16; i++) {
        uint64_t n = (b >> (4 * i)) & 0xf;
        if (n > mx) mx = n;
    }
    if ((b & 0xf) == mx || ((b >> 12) & 0xf) == mx || ((b >> 48) & 0xf) == mx || (b >> 60) == mx)
        return (double)(corner_weight * (int64_t)mx);
    return 0;
}

double evaluate(bitboard_t b, const double *t, int64_t corner_weight) {
    double v = t[(uint16_t)b] + t[(uint16_t)(b >> 16)] + t[(uint16_t)(b >> 32)] + t[(uint16_t)(b >> 48)] +
               t[bb_column(b, 0)] + t[bb_column(b, 1)] + t[bb_column(b, 2)] + t[bb_column(b, 3)];
    if (corner_weight != 0) v += corner_term(b, corner_weight);
    return v;
}

breakdown_t heuristic_breakdown(bitboard_t b, const weights_t *w) {
    uint16_t lines[8] = {(uint16_t)b,      (uint16_t)(b >> 16), (uint16_t)(b >> 32), (uint16_t)(b >> 48),
                         bb_column(b, 0), bb_column(b, 1),     bb_column(b, 2),     bb_column(b, 3)};
    breakdown_t r;
    memset(&r, 0, sizeof r);
    for (int i = 0; i < 8; i++) {
        line_features_t f = line_features(lines[i]);
        r.f.empty += f.empty;
        r.f.merges += f.merges;
        r.f.mono += f.mono;
        r.f.sum += f.sum;
        r.f.smooth += f.smooth;
        r.f.stable += f.stable;
    }
    r.corner = corner_term(b, w->corner);
    r.total = evaluate(b, line_table(w), w->corner);
    return r;
}

/* ---------- config ---------- */

ai_config_t canonical_config(void) {
    ai_config_t c;
    memset(&c, 0, sizeof c);
    c.auto_depth = 1;
    c.min_depth = 2;
    c.max_depth = 4;
    c.tt_bits = 20;
    c.weights = HEURISTIC_V1;
    return c;
}

static int as_int(const char *key, const jval *v, int64_t *out, char *err, size_t errlen) {
    if (!v || v->t != J_NUM) {
        snprintf(err, errlen, "config %s must be a number", key);
        return -1;
    }
    double f = v->num;
    if (f != trunc(f) || isinf(f)) {
        char num[64];
        json_fmt_double(f, num, sizeof num);
        snprintf(err, errlen, "config %s must be an integer (got %s)", key, num);
        return -1;
    }
    *out = (int64_t)f;
    return 0;
}

int parse_config(const jval *obj, ai_config_t *out, char *err, size_t errlen) {
    ai_config_t c = canonical_config();
    *out = c;
    if (!obj || obj->t == J_NULL) return 0;
    if (obj->t != J_OBJ) {
        snprintf(err, errlen, "agent config must be an object");
        return -1;
    }
    for (size_t i = 0; i < obj->n; i++) {
        const char *k = obj->keys[i];
        const jval *v = obj->items[i];
        int64_t n = 0;
        if (strcmp(k, "depth") == 0) {
            if (v->t == J_STR) {
                if (strcmp(v->str, "auto") != 0) {
                    snprintf(err, errlen, "config depth must be an integer or \"auto\"");
                    return -1;
                }
                c.auto_depth = 1;
            } else {
                if (as_int(k, v, &n, err, errlen)) return -1;
                if (n < 1) {
                    snprintf(err, errlen, "config depth must be >= 1");
                    return -1;
                }
                c.auto_depth = 0;
                c.depth = (int)n;
            }
        } else if (strcmp(k, "minDepth") == 0) {
            if (as_int(k, v, &n, err, errlen)) return -1;
            c.min_depth = (int)n;
        } else if (strcmp(k, "maxDepth") == 0) {
            if (as_int(k, v, &n, err, errlen)) return -1;
            c.max_depth = (int)n;
        } else if (strcmp(k, "fourPruneEmpties") == 0) {
            if (as_int(k, v, &n, err, errlen)) return -1;
            c.four_prune_empties = (int)n;
        } else if (strcmp(k, "timeBudgetMs") == 0) {
            if (v->t != J_NUM) {
                snprintf(err, errlen, "config timeBudgetMs must be a number");
                return -1;
            }
            c.time_budget_ms = v->num;
        } else if (strcmp(k, "ttBits") == 0) {
            if (as_int(k, v, &n, err, errlen)) return -1;
            if (n < 4 || n > 28) {
                snprintf(err, errlen, "config ttBits out of range");
                return -1;
            }
            c.tt_bits = (int)n;
        } else if (strcmp(k, "weights") == 0) {
            if (v->t != J_OBJ) {
                snprintf(err, errlen, "config weights must be an object");
                return -1;
            }
            for (size_t j = 0; j < v->n; j++) {
                const char *wk = v->keys[j];
                char key[64], e2[160];
                snprintf(key, sizeof key, "weights.%s", wk);
                if (as_int(key, v->items[j], &n, e2, sizeof e2)) {
                    char num[64] = "?";
                    if (v->items[j]->t == J_NUM) json_fmt_double(v->items[j]->num, num, sizeof num);
                    snprintf(err, errlen, "heuristic weight '%s' must be an integer (got %s)", wk, num);
                    return -1;
                }
                if (strcmp(wk, "lost") == 0) c.weights.lost = n;
                else if (strcmp(wk, "empty") == 0) c.weights.empty = n;
                else if (strcmp(wk, "merges") == 0) c.weights.merges = n;
                else if (strcmp(wk, "mono") == 0) c.weights.mono = n;
                else if (strcmp(wk, "sum") == 0) c.weights.sum = n;
                else if (strcmp(wk, "smooth") == 0) c.weights.smooth = n;
                else if (strcmp(wk, "stable") == 0) c.weights.stable = n;
                else if (strcmp(wk, "corner") == 0) c.weights.corner = n;
            }
        }
    }
    *out = c;
    return 0;
}

/* ---------- search ---------- */

/* Transposition table: exact key (board, depth). Mirrors the TS reference
 * (hash, 4-slot linear probe, store policy, clear at 75%) so that node and
 * hit counts are comparable across ports. depth == 0 marks an empty slot.
 * Stored as parallel arrays: probes touch the compact depth array first. */

struct search {
    ai_config_t config;
    const double *table;
    int64_t corner;
    uint64_t *tt_board;
    double *tt_value;
    uint8_t *tt_depth;
    uint32_t tt_mask;
    int64_t tt_size;
    int64_t nodes, tt_hits;
    int64_t deadline_ns;
    int timed, aborted;
};

static inline uint32_t tt_slot(const search_t *s, uint64_t b, int d) {
    uint32_t lo = (uint32_t)b, hi = (uint32_t)(b >> 32);
    uint32_t h = ((lo ^ ((uint32_t)d * 0x9e3779b1u)) * 0x85ebca6bu) ^ (hi * 0xc2b2ae35u);
    h ^= h >> 15;
    h *= 0x2c1b3c6du;
    h ^= h >> 12;
    return h & s->tt_mask;
}

static void tt_clear(search_t *s) {
    memset(s->tt_depth, 0, (size_t)s->tt_mask + 1);
    s->tt_size = 0;
}

search_t *search_new(const ai_config_t *c) {
    search_t *s = calloc(1, sizeof *s);
    if (!s) {
        fprintf(stderr, "out of memory\n");
        exit(1);
    }
    s->config = *c;
    if (s->config.tt_bits == 0) s->config.tt_bits = 20;
    s->table = line_table(&s->config.weights);
    s->corner = s->config.weights.corner;
    size_t n = (size_t)1 << s->config.tt_bits;
    s->tt_board = calloc(n, sizeof *s->tt_board);
    s->tt_value = calloc(n, sizeof *s->tt_value);
    s->tt_depth = calloc(n, sizeof *s->tt_depth);
    if (!s->tt_board || !s->tt_value || !s->tt_depth) {
        fprintf(stderr, "out of memory\n");
        exit(1);
    }
    s->tt_mask = (uint32_t)(n - 1);
    return s;
}

void search_free(search_t *s) {
    if (!s) return;
    free(s->tt_board);
    free(s->tt_value);
    free(s->tt_depth);
    free(s);
}

const ai_config_t *search_config(const search_t *s) { return &s->config; }

int search_depth_for(const search_t *s, bitboard_t b) {
    const ai_config_t *c = &s->config;
    if (!c->auto_depth) return c->depth;
    int d = bb_distinct_ranks(b) - 2;
    if (d > c->max_depth) d = c->max_depth;
    if (d < c->min_depth) d = c->min_depth;
    return d;
}

static double chance(search_t *s, bitboard_t b, int d);

static double maxnode(search_t *s, bitboard_t b, int d) {
    s->nodes++;
    if (d == 0) return evaluate(b, s->table, s->corner);
    double best = 0.0;
    for (int dir = 0; dir < 4; dir++) {
        bitboard_t nb = bb_move(b, dir);
        if (nb == b) continue;
        double v = chance(s, nb, d);
        if (s->aborted) return 0;
        if (v > best) best = v;
    }
    return best;
}

static double chance(search_t *s, bitboard_t b, int d) {
    s->nodes++;
    if (s->timed && (s->nodes & 0xfff) == 0 && now_ns() > s->deadline_ns) {
        s->aborted = 1;
        return 0;
    }
    uint64_t *tb = s->tt_board;
    double *tv = s->tt_value;
    uint8_t *td = s->tt_depth;
    uint32_t mask = s->tt_mask;
    uint32_t home = tt_slot(s, b, d);
    uint32_t sl = home;
    for (int probe = 0; probe < 4; probe++) {
        uint8_t sd = td[sl];
        if (sd == 0) break;
        if (sd == d && tb[sl] == b) {
            s->tt_hits++;
            return tv[sl];
        }
        sl = (sl + 1) & mask;
    }

    int n = count_empty(b);
    int p = s->config.four_prune_empties;
    int four = !(p > 0 && n >= p);
    double sum = 0.0;
    for (int i = 0; i < 16; i++) {
        unsigned sh = 4u * (unsigned)i;
        if ((b >> sh) & 0xf) continue;
        if (four) {
            double v2 = maxnode(s, b | (1ull << sh), d - 1);
            if (s->aborted) return 0;
            sum = sum + 0.9 * v2;
            double v4 = maxnode(s, b | (2ull << sh), d - 1);
            if (s->aborted) return 0;
            sum = sum + 0.1 * v4;
        } else {
            double v2 = maxnode(s, b | (1ull << sh), d - 1);
            if (s->aborted) return 0;
            sum = sum + v2;
        }
    }
    double v = sum / (double)n;

    uint32_t target = home;
    sl = home;
    for (int probe = 0; probe < 4; probe++) {
        if (td[sl] == 0) {
            target = sl;
            s->tt_size++;
            break;
        }
        sl = (sl + 1) & mask;
    }
    tb[target] = b;
    td[target] = (uint8_t)d;
    tv[target] = v;
    return v;
}

typedef struct {
    int move;
    double value;
    double values[4];
    int has_value[4];
} root_result;

static int root(search_t *s, bitboard_t b, int depth, root_result *r) {
    r->move = -1;
    r->value = -INFINITY;
    for (int dir = 0; dir < 4; dir++) {
        r->has_value[dir] = 0;
        r->values[dir] = 0;
    }
    for (int dir = 0; dir < 4; dir++) {
        bitboard_t nb = bb_move(b, dir);
        if (nb == b) continue;
        double v = chance(s, nb, depth);
        if (s->aborted) return 0;
        r->values[dir] = v;
        r->has_value[dir] = 1;
        if (v > r->value) {
            r->value = v;
            r->move = dir;
        }
    }
    return 1;
}

static void fill_result(search_t *s, const root_result *r, int depth, int64_t start, int det,
                        search_result_t *out) {
    out->move = r->move;
    out->value = r->value;
    memcpy(out->values, r->values, sizeof out->values);
    memcpy(out->has_value, r->has_value, sizeof out->has_value);
    out->depth = depth;
    out->nodes = s->nodes;
    out->tt_hits = s->tt_hits;
    out->tt_size = s->tt_size;
    out->time_us = round_us(now_ns() - start);
    out->deterministic = det;
}

void search_run(search_t *s, bitboard_t b, search_result_t *out) {
    int64_t start = now_ns();
    s->nodes = s->tt_hits = 0;
    s->aborted = s->timed = 0;
    if ((double)s->tt_size > (double)((uint64_t)s->tt_mask + 1) * 0.75) tt_clear(s);
    root_result r;
    if (s->config.time_budget_ms <= 0) {
        int depth = search_depth_for(s, b);
        root(s, b, depth, &r);
        fill_result(s, &r, depth, start, 1, out);
        out->completed[0] = depth;
        out->n_completed = 1;
        return;
    }
    root_result best;
    root(s, b, 1, &best);
    int depth = 1;
    int completed[32] = {1};
    int nc = 1;
    s->timed = 1;
    s->deadline_ns = start + (int64_t)(s->config.time_budget_ms * 1e6);
    for (int d = 2; d <= s->config.max_depth; d++) {
        if (!root(s, b, d, &r)) break;
        best = r;
        depth = d;
        if (nc < 32) completed[nc++] = d;
    }
    s->timed = s->aborted = 0;
    fill_result(s, &best, depth, start, 0, out);
    memcpy(out->completed, completed, sizeof completed);
    out->n_completed = nc;
}

/* ---------- agents ---------- */

agent_t *agent_new(const char *id, const jval *config, char *err, size_t errlen) {
    agent_t *a = calloc(1, sizeof *a);
    if (!a) {
        fprintf(stderr, "out of memory\n");
        exit(1);
    }
    if (strcmp(id, "random") == 0) {
        a->kind = AGENT_RANDOM;
        a->id = "random";
        rng_seed(&a->rng, 0);
    } else if (strcmp(id, "greedy") == 0) {
        a->kind = AGENT_GREEDY;
        a->id = "greedy";
    } else if (strcmp(id, "expectimax") == 0) {
        ai_config_t c;
        if (parse_config(config, &c, err, errlen)) {
            free(a);
            return NULL;
        }
        a->kind = AGENT_EXPECTIMAX;
        a->id = "expectimax";
        a->search = search_new(&c);
    } else {
        snprintf(err, errlen, "unknown agent '%s'", id);
        free(a);
        return NULL;
    }
    return a;
}

void agent_free(agent_t *a) {
    if (!a) return;
    search_free(a->search);
    free(a);
}

void agent_reset(agent_t *a, uint32_t seed) {
    if (a->kind == AGENT_RANDOM) rng_seed(&a->rng, seed ^ 0xA5A5A5A5u);
}

static int first_valid(const board_t *board) {
    for (int d = 0; d < 4; d++)
        if (board_can_move(board, d)) return d;
    return -1;
}

void agent_decide(agent_t *a, const board_t *board, decision_t *d) {
    int64_t t = now_ns();
    d->has_search = 0;
    d->nodes = 0;
    switch (a->kind) {
    case AGENT_RANDOM: {
        int valid[4], n = 0;
        for (int dir = 0; dir < 4; dir++)
            if (board_can_move(board, dir)) valid[n++] = dir;
        d->move = n ? valid[rng_below(&a->rng, (uint64_t)n)] : -1;
        d->time_us = round_us(now_ns() - t);
        return;
    }
    case AGENT_GREEDY: {
        bitboard_t b = bb_from_board(board);
        int best = first_valid(board), best_score = -1;
        for (int dir = 0; dir < 4; dir++) {
            bitboard_t nb = bb_move(b, dir);
            if (nb == b) continue;
            int empty = count_empty(nb);
            if (empty > best_score) {
                best_score = empty;
                best = dir;
            }
        }
        d->move = best;
        d->time_us = round_us(now_ns() - t);
        return;
    }
    case AGENT_EXPECTIMAX: {
        bitboard_t b = bb_from_board(board);
        search_run(a->search, b, &d->result);
        d->move = d->result.move >= 0 ? d->result.move : first_valid(board);
        d->has_search = 1;
        d->nodes = d->result.nodes;
        d->time_us = d->result.time_us;
        return;
    }
    }
}

int agent_is_deterministic(const agent_t *a) {
    if (a->kind == AGENT_EXPECTIMAX) return !(a->search->config.time_budget_ms > 0);
    return 1;
}
