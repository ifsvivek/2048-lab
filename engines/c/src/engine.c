#include "engine.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

const char DIRECTION_LETTERS[5] = "UDLR";
const char *const DIRECTION_NAMES[4] = {"up", "down", "left", "right"};
const char REPLAY_ALPHABET[33] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
static const char CROCKFORD[33] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
static const char HEX_DIGITS[37] = "0123456789abcdefghijklmnopqrstuvwxyz";

int LINES[4][4][4];

void engine_init(void) {
    for (int k = 0; k < 4; k++) {
        for (int j = 0; j < 4; j++) {
            LINES[DIR_UP][k][j] = j * 4 + k;
            LINES[DIR_DOWN][k][j] = (3 - j) * 4 + k;
            LINES[DIR_LEFT][k][j] = k * 4 + j;
            LINES[DIR_RIGHT][k][j] = k * 4 + 3 - j;
        }
    }
}

/* ---------- RNG ---------- */

static inline uint32_t rotl32(uint32_t x, int k) { return (x << k) | (x >> (32 - k)); }

void mix32(uint32_t seed, uint32_t s[4]) {
    uint32_t x = seed;
    for (int k = 0; k < 4; k++) {
        x += 0x9E3779B9u;
        uint32_t z = x;
        z = (z ^ (z >> 16)) * 0x85EBCA6Bu;
        z = (z ^ (z >> 13)) * 0xC2B2AE35u;
        s[k] = z ^ (z >> 16);
    }
    if (s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0) s[0] = 1;
}

void rng_seed(rng_t *r, uint32_t seed) { mix32(seed, r->s); }

uint32_t rng_next(rng_t *r) {
    uint32_t *s = r->s;
    uint32_t result = rotl32(s[1] * 5u, 7) * 9u;
    uint32_t t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl32(s[3], 11);
    return result;
}

uint32_t rng_below(rng_t *r, uint64_t n) {
    const uint64_t two32 = (uint64_t)1 << 32;
    uint64_t limit = two32 - two32 % n;
    for (;;) {
        uint64_t x = rng_next(r);
        if (x < limit) return (uint32_t)(x % n);
    }
}

/* ---------- Board ---------- */

void board_hex(const board_t *b, char hex[17]) {
    for (int i = 0; i < 16; i++) hex[i] = b->c[i] < 36 ? HEX_DIGITS[b->c[i]] : '?';
    hex[16] = 0;
}

int board_from_hex(const char *hex, board_t *b, char *err, size_t errlen) {
    memset(b, 0, sizeof *b);
    size_t n = strlen(hex);
    if (n != 16) {
        if (err) snprintf(err, errlen, "boardHex must be 16 chars, got %zu", n);
        return -1;
    }
    for (int i = 0; i < 16; i++) {
        char c = (char)tolower((unsigned char)hex[i]);
        const char *p = c ? strchr(HEX_DIGITS, c) : NULL;
        if (!p) {
            if (err) snprintf(err, errlen, "invalid boardHex character '%c'", hex[i]);
            return -1;
        }
        b->c[i] = (uint8_t)(p - HEX_DIGITS);
    }
    return 0;
}

uint8_t board_max_exponent(const board_t *b) {
    uint8_t m = 0;
    for (int i = 0; i < 16; i++)
        if (b->c[i] > m) m = b->c[i];
    return m;
}

int64_t board_max_tile(const board_t *b) {
    uint8_t e = board_max_exponent(b);
    return e ? (int64_t)1 << e : 0;
}

int64_t board_move(board_t *b, int dir) {
    int64_t gained = 0;
    int changed = 0;
    for (int l = 0; l < 4; l++) {
        const int *idx = LINES[dir][l];
        uint8_t tiles[4];
        int n = 0;
        for (int k = 0; k < 4; k++) {
            uint8_t v = b->c[idx[k]];
            if (v) tiles[n++] = v;
        }
        uint8_t res[4] = {0, 0, 0, 0};
        int out = 0;
        for (int i = 0; i < n;) {
            if (i + 1 < n && tiles[i] == tiles[i + 1]) {
                uint8_t e = (uint8_t)(tiles[i] + 1);
                res[out] = e;
                gained += (int64_t)1 << e;
                i += 2;
            } else {
                res[out] = tiles[i];
                i++;
            }
            out++;
        }
        for (int k = 0; k < 4; k++) {
            if (b->c[idx[k]] != res[k]) {
                b->c[idx[k]] = res[k];
                changed = 1;
            }
        }
    }
    return changed ? gained : -1;
}

int board_can_move(const board_t *b, int dir) {
    for (int l = 0; l < 4; l++) {
        const int *idx = LINES[dir][l];
        for (int k = 1; k < 4; k++) {
            uint8_t prev = b->c[idx[k - 1]], cur = b->c[idx[k]];
            if (cur != 0 && (prev == 0 || prev == cur)) return 1;
        }
    }
    return 0;
}

int board_is_over(const board_t *b) {
    for (int d = 0; d < 4; d++)
        if (board_can_move(b, d)) return 0;
    return 1;
}

int board_spawn(board_t *b, rng_t *r, int *index, uint8_t *exponent) {
    int empties[16];
    int n = 0;
    for (int i = 0; i < 16; i++)
        if (b->c[i] == 0) empties[n++] = i;
    if (n == 0) return 0;
    int i = empties[rng_below(r, (uint64_t)n)];
    uint8_t e = rng_below(r, 10) == 0 ? 2 : 1;
    b->c[i] = e;
    if (index) *index = i;
    if (exponent) *exponent = e;
    return 1;
}

int parse_direction(const char *s) {
    char t[16];
    size_t k = 0;
    while (*s && isspace((unsigned char)*s)) s++;
    for (; *s && k < sizeof t - 1; s++) t[k++] = (char)tolower((unsigned char)*s);
    while (k > 0 && isspace((unsigned char)t[k - 1])) k--;
    t[k] = 0;
    for (int i = 0; i < 4; i++)
        if (strcmp(t, DIRECTION_NAMES[i]) == 0) return i;
    if (k == 1) {
        const char *p = strchr("udlr", t[0]);
        if (p) return (int)(p - "udlr");
        if (t[0] >= '0' && t[0] <= '3') return t[0] - '0';
    }
    return -1;
}

/* ---------- Hashes ---------- */

#define FNV_OFFSET 0x811C9DC5u
#define FNV_PRIME 0x01000193u

uint32_t fnv1a32(const void *data, size_t n) {
    const uint8_t *p = data;
    uint32_t h = FNV_OFFSET;
    for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * FNV_PRIME;
    return h;
}

uint32_t board_hash(const board_t *b) { return fnv1a32(b->c, 16); }

uint32_t history_step(uint32_t h, const board_t *b, int dir) {
    uint32_t x = FNV_OFFSET;
    for (int k = 0; k < 4; k++) x = (x ^ ((h >> (8 * k)) & 0xffu)) * FNV_PRIME;
    for (int i = 0; i < 16; i++) x = (x ^ b->c[i]) * FNV_PRIME;
    return (x ^ (uint32_t)dir) * FNV_PRIME;
}

void hash_hex(uint32_t h, char out[9]) { snprintf(out, 9, "%08x", (unsigned)h); }

/* ---------- Game ---------- */

void game_init(game_t *g, uint32_t seed) {
    memset(g, 0, sizeof *g);
    g->seed = seed;
    rng_seed(&g->rng, seed);
    board_spawn(&g->board, &g->rng, NULL, NULL);
    board_spawn(&g->board, &g->rng, NULL, NULL);
    g->hash = board_hash(&g->board);
    g->moves_cap = 256;
    g->moves = malloc(g->moves_cap);
    if (!g->moves) {
        fprintf(stderr, "out of memory\n");
        exit(1);
    }
    g->moves[0] = 0;
}

void game_free(game_t *g) {
    free(g->moves);
    g->moves = NULL;
}

int64_t game_apply(game_t *g, int dir) {
    int64_t gained = board_move(&g->board, dir);
    if (gained < 0) return -1;
    g->score += gained;
    g->move_count++;
    board_spawn(&g->board, &g->rng, NULL, NULL);
    g->hash = history_step(g->hash, &g->board, dir);
    if ((size_t)g->move_count + 1 > g->moves_cap) {
        g->moves_cap *= 2;
        g->moves = realloc(g->moves, g->moves_cap);
        if (!g->moves) {
            fprintf(stderr, "out of memory\n");
            exit(1);
        }
    }
    g->moves[g->move_count - 1] = DIRECTION_LETTERS[dir];
    g->moves[g->move_count] = 0;
    return gained;
}

int game_over(const game_t *g) { return board_is_over(&g->board); }

void game_snapshot(const game_t *g, snapshot_t *s) {
    s->seed = g->seed;
    board_hex(&g->board, s->board);
    s->score = g->score;
    s->move_count = g->move_count;
    s->max_tile = board_max_tile(&g->board);
    s->over = game_over(g);
    hash_hex(g->hash, s->history_hash);
}

/* ---------- Replays ---------- */

static void set_err(replay_err_t *e, const char *code, int idx, const char *msg) {
    if (!e) return;
    e->code = code;
    e->move_index = idx;
    snprintf(e->message, sizeof e->message, "%s", msg);
}

int simulate(uint32_t seed, const char *moves, game_t *g, replay_err_t *err) {
    game_init(g, seed);
    char msg[160];
    for (int i = 0; moves[i]; i++) {
        const char *p = strchr(DIRECTION_LETTERS, moves[i]);
        if (!p) {
            snprintf(msg, sizeof msg, "bad move letter '%c' at %d", moves[i], i);
            set_err(err, "BAD_LETTER", i, msg);
            game_free(g);
            return -1;
        }
        if (game_apply(g, (int)(p - DIRECTION_LETTERS)) < 0) {
            snprintf(msg, sizeof msg, "INVALID_MOVE_AT %d", i);
            set_err(err, "INVALID_MOVE_AT", i, msg);
            game_free(g);
            return -1;
        }
    }
    if (err) err->code = NULL;
    return 0;
}

int verify_replay(int spec_version, uint32_t seed, const char *moves, const final_claim_t *final, snapshot_t *out,
                  replay_err_t *err) {
    char msg[160];
    memset(out, 0, sizeof *out);
    if (spec_version != SPEC_VERSION) {
        snprintf(msg, sizeof msg, "unsupported specVersion %d", spec_version);
        set_err(err, "SPEC_VERSION", -1, msg);
        return -1;
    }
    game_t g;
    if (simulate(seed, moves, &g, err) != 0) return -1;
    game_snapshot(&g, out);
    game_free(&g);
    if (final) {
        if (final->board && strcmp(final->board, out->board) != 0) {
            snprintf(msg, sizeof msg, "final.board mismatch: claimed %s, actual %s", final->board, out->board);
            set_err(err, "FINAL_MISMATCH", -1, msg);
            return -1;
        }
        if (final->score && *final->score != out->score) {
            snprintf(msg, sizeof msg, "final.score mismatch: claimed %lld, actual %lld", (long long)*final->score,
                     (long long)out->score);
            set_err(err, "FINAL_MISMATCH", -1, msg);
            return -1;
        }
        if (final->move_count && *final->move_count != out->move_count) {
            snprintf(msg, sizeof msg, "final.moveCount mismatch: claimed %d, actual %d", *final->move_count,
                     out->move_count);
            set_err(err, "FINAL_MISMATCH", -1, msg);
            return -1;
        }
        if (final->history_hash && strcmp(final->history_hash, out->history_hash) != 0) {
            snprintf(msg, sizeof msg, "final.historyHash mismatch: claimed %s, actual %s", final->history_hash,
                     out->history_hash);
            set_err(err, "FINAL_MISMATCH", -1, msg);
            return -1;
        }
    }
    if (err) err->code = NULL;
    return 0;
}

/* ---------- Identifiers ---------- */

void random_bytes(void *buf, size_t n) {
    FILE *f = fopen("/dev/urandom", "rb");
    if (f) {
        size_t got = fread(buf, 1, n, f);
        fclose(f);
        if (got == n) return;
    }
    fprintf(stderr, "error: cannot read /dev/urandom\n");
    exit(1);
}

uint32_t random_seed(void) {
    uint8_t b[4];
    random_bytes(b, 4);
    return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
}

void ulid_now(char out[27]) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    uint64_t t = (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
    for (int i = 9; i >= 0; i--) {
        out[i] = CROCKFORD[t % 32];
        t /= 32;
    }
    uint8_t rnd[16];
    random_bytes(rnd, 16);
    for (int i = 0; i < 16; i++) out[10 + i] = CROCKFORD[rnd[i] & 31];
    out[26] = 0;
}

int is_ulid(const char *s) {
    if (strlen(s) != 26) return 0;
    for (int i = 0; i < 26; i++)
        if (!strchr(CROCKFORD, s[i]) || s[i] == 0) return 0;
    return 1;
}

void format_replay_code(const char *n, char out[15]) {
    snprintf(out, 15, "%.4s-%.4s-%.4s", n, n + 4, n + 8);
}

void generate_replay_code(char out[15]) {
    uint8_t rnd[12];
    char s[13];
    random_bytes(rnd, 12);
    for (int i = 0; i < 12; i++) s[i] = REPLAY_ALPHABET[rnd[i] & 31];
    s[12] = 0;
    format_replay_code(s, out);
}

int normalize_replay_code(const char *input, char out[13]) {
    size_t k = 0;
    for (const unsigned char *p = (const unsigned char *)input; *p; p++) {
        char c = (char)toupper(*p);
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
            if (k >= 12) {
                out[12] = 0;
                return 0;
            }
            out[k++] = c;
        }
    }
    out[k] = 0;
    if (k != 12) return 0;
    for (int i = 0; i < 12; i++)
        if (!strchr(REPLAY_ALPHABET, out[i])) return 0;
    return 1;
}
