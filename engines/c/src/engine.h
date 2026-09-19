/* Canonical 2048 rules (spec/SPEC.md). */
#ifndef G2048_ENGINE_H
#define G2048_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#define SPEC_VERSION 1
#define ENGINE_VERSION "1.0.0"

enum { DIR_UP = 0, DIR_DOWN = 1, DIR_LEFT = 2, DIR_RIGHT = 3 };

extern const char DIRECTION_LETTERS[5];   /* "UDLR" */
extern const char *const DIRECTION_NAMES[4];
extern const char REPLAY_ALPHABET[33];
/* LINES[dir][line][k]: cell indices starting at the edge tiles slide toward. */
extern int LINES[4][4][4];

/* ---------- RNG (SPEC §4) ---------- */

typedef struct {
    uint32_t s[4];
} rng_t;

void mix32(uint32_t seed, uint32_t out[4]);
void rng_seed(rng_t *r, uint32_t seed);
uint32_t rng_next(rng_t *r);
/* Unbiased integer in [0, n), 1 <= n <= 2^32. */
uint32_t rng_below(rng_t *r, uint64_t n);

/* ---------- Board (SPEC §1-3, 5) ---------- */

typedef struct {
    uint8_t c[16];
} board_t;

void engine_init(void);
/* hex must have room for 17 bytes. */
void board_hex(const board_t *b, char hex[17]);
/* Returns 0 on success, -1 on error (msg written to err). */
int board_from_hex(const char *hex, board_t *b, char *err, size_t errlen);
uint8_t board_max_exponent(const board_t *b);
int64_t board_max_tile(const board_t *b);
/* Applies dir in place; returns gained score, or -1 if invalid (board untouched). */
int64_t board_move(board_t *b, int dir);
int board_can_move(const board_t *b, int dir);
int board_is_over(const board_t *b);
/* Spawns a tile; returns 1 and writes index/exponent, or 0 if the board is full. */
int board_spawn(board_t *b, rng_t *r, int *index, uint8_t *exponent);
/* Accepts names ("left"), letters ("L") or digits ("2"); -1 if invalid. */
int parse_direction(const char *s);

/* ---------- Hashes (SPEC §7) ---------- */

uint32_t fnv1a32(const void *data, size_t n);
uint32_t board_hash(const board_t *b);
uint32_t history_step(uint32_t h, const board_t *b, int dir);
void hash_hex(uint32_t h, char out[9]);

/* ---------- Game (SPEC §6) ---------- */

typedef struct {
    uint32_t seed;
    board_t board;
    int64_t score;
    int move_count;
    rng_t rng;
    uint32_t hash;
    char *moves; /* NUL-terminated move letters */
    size_t moves_cap;
} game_t;

typedef struct {
    uint32_t seed;
    char board[17];
    int64_t score;
    int move_count;
    int64_t max_tile;
    int over;
    char history_hash[9];
} snapshot_t;

void game_init(game_t *g, uint32_t seed);
void game_free(game_t *g);
/* Returns gained score, or -1 if the move is invalid (no state change). */
int64_t game_apply(game_t *g, int dir);
int game_over(const game_t *g);
void game_snapshot(const game_t *g, snapshot_t *s);

/* ---------- Replays (SPEC §8) ---------- */

typedef struct {
    const char *code; /* NULL on success */
    char message[160];
    int move_index; /* -1 when not applicable */
} replay_err_t;

typedef struct {
    const char *board;        /* NULL = not checked */
    const int64_t *score;
    const int *move_count;
    const char *history_hash;
} final_claim_t;

/* Simulates moves from seed. On success returns 0 and fills g (caller frees). */
int simulate(uint32_t seed, const char *moves, game_t *g, replay_err_t *err);
/* Re-simulates a replay; returns 0 on success, -1 on error (err filled). */
int verify_replay(int spec_version, uint32_t seed, const char *moves, const final_claim_t *final, snapshot_t *out,
                  replay_err_t *err);

/* ---------- Identifiers (SPEC §9) ---------- */

void random_bytes(void *buf, size_t n);
uint32_t random_seed(void);
void ulid_now(char out[27]);
int is_ulid(const char *s);
void generate_replay_code(char out[15]);
/* Returns 1 and writes 12 chars (+NUL) if valid. */
int normalize_replay_code(const char *input, char out[13]);
void format_replay_code(const char *normalized, char out[15]);

#endif
