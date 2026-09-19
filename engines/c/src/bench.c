#include "bench.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

/* ---------- suites ---------- */

int suite_load(const char *path, suite_t *s, char *err, size_t errlen) {
    memset(s, 0, sizeof *s);
    jval *doc = json_load(path, err, errlen);
    if (!doc) return -1;
    if (doc->t != J_OBJ) {
        snprintf(err, errlen, "%s: suite must be a JSON object", path);
        json_free(doc);
        return -1;
    }
    s->doc = doc;
    s->id = json_str(json_get(doc, "id"));
    if (!s->id) s->id = "";
    s->spec_version = (int)json_num(json_get(doc, "specVersion"), 0);
    jval *agent = json_get(doc, "agent");
    s->agent_id = json_str(json_get(agent, "id"));
    if (!s->agent_id) s->agent_id = "";
    jval *cfg = json_get(agent, "config");
    s->agent_config = json_is_null(cfg) ? NULL : cfg;
    jval *seeds = json_get(doc, "seeds");
    s->seed_start = (uint32_t)json_num(json_get(seeds, "start"), 0);
    s->seed_count = (int)json_num(json_get(seeds, "count"), 0);
    s->max_moves = (int)json_num(json_get(doc, "maxMoves"), 0);
    jval *td = json_get(doc, "timeDecisions");
    s->time_decisions = td && td->t == J_BOOL && td->b;
    return 0;
}

void suite_free(suite_t *s) {
    json_free(s->doc);
    s->doc = NULL;
}

int suite_has_tag(const suite_t *s, const char *tag) {
    jval *tags = json_get(s->doc, "tags");
    for (size_t i = 0; tags && tags->t == J_ARR && i < tags->n; i++) {
        const char *t = json_str(tags->items[i]);
        if (t && strcmp(t, tag) == 0) return 1;
    }
    return 0;
}

/* ---------- play ---------- */

static double ms_since(int64_t t0) { return (double)(now_ns() - t0) / 1e6; }

int bench_play(agent_t *agent, uint32_t seed, int max_moves, decision_cb cb, void *ctx, play_result_t *pr,
               char *err, size_t errlen) {
    int64_t t0 = now_ns();
    game_t *g = &pr->game;
    game_init(g, seed);
    agent_reset(agent, seed);
    int64_t nodes = 0;
    decision_t d;
    while ((max_moves <= 0 || g->move_count < max_moves) && !game_over(g)) {
        agent_decide(agent, &g->board, &d);
        if (d.move < 0) {
            snprintf(err, errlen, "agent %s returned no move at %d", agent->id, g->move_count);
            game_free(g);
            return -1;
        }
        if (game_apply(g, d.move) < 0) {
            snprintf(err, errlen, "agent %s returned invalid move %d at %d", agent->id, d.move, g->move_count);
            game_free(g);
            return -1;
        }
        if (d.has_search) nodes += d.nodes;
        if (cb) cb(ctx, d.time_us);
    }
    pr->nodes = nodes;
    pr->wall_ms = ms_since(t0);
    return 0;
}

/* ---------- host facts ---------- */

static double cpu_ms(int *ok) {
    struct rusage ru;
    if (getrusage(RUSAGE_SELF, &ru) != 0) {
        *ok = 0;
        return 0;
    }
    *ok = 1;
    int64_t ns = ((int64_t)ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1000000000 +
                 ((int64_t)ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) * 1000;
    return (double)ns / 1e6;
}

static int64_t peak_memory(int *ok) {
    struct rusage ru;
    if (getrusage(RUSAGE_SELF, &ru) != 0) {
        *ok = 0;
        return 0;
    }
    *ok = 1;
#ifdef __APPLE__
    return (int64_t)ru.ru_maxrss; /* bytes */
#else
    return (int64_t)ru.ru_maxrss * 1024; /* KiB */
#endif
}

static const char *os_name(void) {
#if defined(__linux__)
    return "linux";
#elif defined(__APPLE__)
    return "darwin";
#elif defined(__FreeBSD__)
    return "freebsd";
#elif defined(_WIN32)
    return "windows";
#else
    return "unknown";
#endif
}

static const char *arch_name(void) {
#if defined(__x86_64__)
    return "amd64";
#elif defined(__aarch64__)
    return "arm64";
#elif defined(__i386__)
    return "386";
#elif defined(__arm__)
    return "arm";
#elif defined(__riscv) && __riscv_xlen == 64
    return "riscv64";
#else
    return "unknown";
#endif
}

static const char *compiler_version(void) {
#if defined(__clang__)
    return "clang " __clang_version__;
#elif defined(__GNUC__)
    return "gcc " __VERSION__;
#else
    return "unknown";
#endif
}

static jval *environment(void) {
    /* keys in sorted order, like Go's map encoding */
    jval *env = jobject();
    jset(env, "arch", jstring(arch_name()));
    FILE *f = fopen("/proc/cpuinfo", "r");
    if (f) {
        char line[512];
        while (fgets(line, sizeof line, f)) {
            char *colon = strchr(line, ':');
            if (!colon) continue;
            char key[128];
            size_t kl = (size_t)(colon - line);
            if (kl >= sizeof key) continue;
            memcpy(key, line, kl);
            key[kl] = 0;
            while (kl > 0 && (key[kl - 1] == ' ' || key[kl - 1] == '\t')) key[--kl] = 0;
            char *k = key;
            while (*k == ' ' || *k == '\t') k++;
            if (strcmp(k, "model name") != 0) continue;
            char *v = colon + 1;
            while (*v == ' ' || *v == '\t') v++;
            size_t vl = strlen(v);
            while (vl > 0 && (v[vl - 1] == '\n' || v[vl - 1] == ' ' || v[vl - 1] == '\t' || v[vl - 1] == '\r'))
                v[--vl] = 0;
            jset(env, "cpu", jstring(v));
            break;
        }
        fclose(f);
    }
    long cpus = sysconf(_SC_NPROCESSORS_ONLN);
    jset(env, "cpus", jint(cpus > 0 ? cpus : 1));
    f = fopen("/proc/meminfo", "r");
    if (f) {
        char line[256];
        long long kb;
        while (fgets(line, sizeof line, f)) {
            if (sscanf(line, "MemTotal: %lld kB", &kb) == 1) {
                jset(env, "memoryBytes", jint((int64_t)kb * 1024));
                break;
            }
        }
        fclose(f);
    }
    jset(env, "os", jstring(os_name()));
    return env;
}

static void iso_now(char out[32]) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    gmtime_r(&ts.tv_sec, &tm);
    char base[20];
    strftime(base, sizeof base, "%Y-%m-%dT%H:%M:%S", &tm);
    snprintf(out, 32, "%s.%03dZ", base, (int)(ts.tv_nsec / 1000000) % 1000);
}

/* ---------- summary ---------- */

typedef struct {
    double *v;
    size_t n, cap;
} dvec;

static void on_decision(void *ctx, int64_t us) {
    dvec *d = ctx;
    if (d->n == d->cap) {
        d->cap = d->cap ? d->cap * 2 : 1024;
        d->v = realloc(d->v, d->cap * sizeof *d->v);
        if (!d->v) {
            fprintf(stderr, "out of memory\n");
            exit(1);
        }
    }
    d->v[d->n++] = (double)us;
}

static int cmp_i64(const void *a, const void *b) {
    int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
    return (x > y) - (x < y);
}

static int cmp_f64(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

static double percentile(const double *sorted, size_t n, double p) {
    if (n == 0) return 0;
    size_t i = (size_t)floor(p * (double)n);
    return sorted[i < n - 1 ? i : n - 1];
}

static const int64_t REACH_TILES[] = {2048, 4096, 8192, 16384, 32768, 65536};

static jval *summarise(const game_result_t *games, int n, double wall_ms, const int *cpu_ok, double cpu,
                       const int *peak_ok, int64_t peak, const dvec *decisions, int64_t *total_moves_out,
                       int64_t *max_score_out, double rates[3]) {
    int64_t total = 0, total_moves = 0, nodes = 0, max_tile = 0;
    int64_t *scores = malloc(sizeof(int64_t) * (size_t)(n ? n : 1));
    /* tileDistribution: keys sorted numerically */
    int64_t tiles[64];
    int tile_counts[64];
    int n_tiles = 0;
    for (int i = 0; i < n; i++) {
        scores[i] = games[i].score;
        total += games[i].score;
        total_moves += games[i].move_count;
        nodes += games[i].nodes;
        if (games[i].max_tile > max_tile) max_tile = games[i].max_tile;
        int k;
        for (k = 0; k < n_tiles; k++)
            if (tiles[k] == games[i].max_tile) break;
        if (k == n_tiles && n_tiles < 64) {
            tiles[n_tiles] = games[i].max_tile;
            tile_counts[n_tiles++] = 0;
        }
        if (k < 64) tile_counts[k]++;
    }
    qsort(scores, (size_t)n, sizeof *scores, cmp_i64);
    jval *s = jobject();
    jset(s, "games", jint(n));
    jset(s, "avgScore", jdouble(n ? (double)total / n : 0));
    jset(s, "medianScore", jdouble(n ? (double)scores[n / 2] : 0));
    jset(s, "minScore", jint(n ? scores[0] : 0));
    jset(s, "maxScore", jint(n ? scores[n - 1] : 0));
    jset(s, "maxTile", jint(max_tile));
    jset(s, "totalMoves", jint(total_moves));
    jset(s, "wallMs", jdouble(wall_ms));
    jset(s, "cpuMs", *cpu_ok ? jdouble(cpu) : jnull());
    double secs = wall_ms / 1000, gps = 0, mps = 0, nps = 0;
    if (secs > 0) {
        gps = n / secs;
        mps = (double)total_moves / secs;
        nps = (double)nodes / secs;
    }
    jset(s, "gamesPerSec", jdouble(gps));
    jset(s, "movesPerSec", jdouble(mps));
    jset(s, "decisionsPerSec", jdouble(mps));
    jset(s, "nodes", jint(nodes));
    jset(s, "nodesPerSec", jdouble(nps));
    jset(s, "peakMemoryBytes", *peak_ok ? jint(peak) : jnull());
    if (decisions && decisions->n > 0) {
        double *sorted = malloc(decisions->n * sizeof *sorted);
        memcpy(sorted, decisions->v, decisions->n * sizeof *sorted);
        qsort(sorted, decisions->n, sizeof *sorted, cmp_f64);
        double sum = 0;
        for (size_t i = 0; i < decisions->n; i++) sum += sorted[i];
        jset(s, "avgDecisionUs", jdouble(sum / (double)decisions->n));
        jset(s, "p50DecisionUs", jdouble(percentile(sorted, decisions->n, 0.5)));
        jset(s, "p99DecisionUs", jdouble(percentile(sorted, decisions->n, 0.99)));
        free(sorted);
    } else {
        jset(s, "avgDecisionUs", jnull());
        jset(s, "p50DecisionUs", jnull());
        jset(s, "p99DecisionUs", jnull());
    }
    /* sort tile keys */
    for (int i = 1; i < n_tiles; i++)
        for (int j = i; j > 0 && tiles[j - 1] > tiles[j]; j--) {
            int64_t t = tiles[j];
            tiles[j] = tiles[j - 1];
            tiles[j - 1] = t;
            int c = tile_counts[j];
            tile_counts[j] = tile_counts[j - 1];
            tile_counts[j - 1] = c;
        }
    jval *dist = jobject();
    char key[32];
    for (int i = 0; i < n_tiles; i++) {
        snprintf(key, sizeof key, "%lld", (long long)tiles[i]);
        jset(dist, key, jint(tile_counts[i]));
    }
    jset(s, "tileDistribution", dist);
    jval *reach = jobject();
    for (size_t t = 0; t < sizeof REACH_TILES / sizeof REACH_TILES[0]; t++) {
        double r = 0;
        if (n > 0) {
            int c = 0;
            for (int i = 0; i < n; i++)
                if (games[i].max_tile >= REACH_TILES[t]) c++;
            r = (double)c / n;
        }
        snprintf(key, sizeof key, "%lld", (long long)REACH_TILES[t]);
        jset(reach, key, jdouble(r));
    }
    jset(s, "reachRates", reach);
    *total_moves_out = total_moves;
    *max_score_out = n ? scores[n - 1] : 0;
    rates[0] = gps;
    rates[1] = mps;
    rates[2] = nps;
    free(scores);
    return s;
}

/* ---------- run ---------- */

int bench_run(const suite_t *suite, FILE *progress, bench_result_t *out, char *err, size_t errlen) {
    memset(out, 0, sizeof *out);
    if (suite->spec_version != SPEC_VERSION) {
        snprintf(err, errlen, "suite %s targets spec v%d", suite->id, suite->spec_version);
        return -1;
    }
    agent_t *agent = agent_new(suite->agent_id, suite->agent_config, err, errlen);
    if (!agent) return -1;
    char started[32], finished[32];
    iso_now(started);
    int cpu0_ok;
    double cpu0 = cpu_ms(&cpu0_ok);
    int64_t t0 = now_ns();
    dvec decisions = {0};
    int count = suite->seed_count > 0 ? suite->seed_count : 0;
    game_result_t *games = calloc((size_t)(count ? count : 1), sizeof *games);
    for (int i = 0; i < count; i++) {
        uint32_t seed = suite->seed_start + (uint32_t)i;
        play_result_t pr;
        if (bench_play(agent, seed, suite->max_moves, suite->time_decisions ? on_decision : NULL, &decisions, &pr,
                       err, errlen)) {
            free(games);
            free(decisions.v);
            agent_free(agent);
            return -1;
        }
        game_result_t *r = &games[i];
        r->seed = seed;
        r->score = pr.game.score;
        r->max_tile = (int64_t)1 << board_max_exponent(&pr.game.board);
        r->move_count = pr.game.move_count;
        r->over = game_over(&pr.game);
        hash_hex(pr.game.hash, r->history_hash);
        r->wall_ms = pr.wall_ms;
        r->nodes = pr.nodes;
        game_free(&pr.game);
        if (progress && (count <= 100 || (i + 1) % 100 == 0 || i + 1 == count)) {
            fprintf(progress, "[%s] game %d/%d seed=%u score=%lld maxTile=%lld moves=%d %.0fms\n", suite->id, i + 1,
                    count, seed, (long long)r->score, (long long)r->max_tile, r->move_count, r->wall_ms);
        }
    }
    double wall_ms = ms_since(t0);
    int cpu1_ok;
    double cpu1 = cpu_ms(&cpu1_ok);
    int cpu_ok = cpu0_ok && cpu1_ok;
    int peak_ok;
    int64_t peak = peak_memory(&peak_ok);

    /* checksum: fnv1a32 over concatenated historyHash strings */
    char *cat = malloc((size_t)count * 8 + 1);
    for (int i = 0; i < count; i++) memcpy(cat + (size_t)i * 8, games[i].history_hash, 8);
    hash_hex(fnv1a32(cat, (size_t)count * 8), out->checksum);
    free(cat);

    jval *res = jobject();
    jset(res, "schemaVersion", jint(1));
    jset(res, "suiteId", jstring(suite->id));
    jset(res, "specVersion", jint(SPEC_VERSION));
    jval *impl = jobject();
    jset(impl, "language", jstring("c"));
    jset(impl, "runtime", jstring("native"));
    jset(impl, "runtimeVersion", jstring(compiler_version()));
    jset(impl, "engineVersion", jstring(ENGINE_VERSION));
    jset(impl, "platform", jstring(os_name()));
    jset(res, "implementation", impl);
    jset(res, "environment", environment());
    jval *ag = jobject();
    jset(ag, "id", jstring(suite->agent_id));
    if (suite->agent_config) jset(ag, "config", jclone(suite->agent_config));
    jset(res, "agent", ag);
    jset(res, "deterministic", jbool(agent_is_deterministic(agent)));
    jset(res, "startedAt", jstring(started));
    iso_now(finished);
    jset(res, "finishedAt", jstring(finished));
    jval *garr = jarray();
    int64_t total_score = 0;
    for (int i = 0; i < count; i++) {
        const game_result_t *r = &games[i];
        total_score += r->score;
        jval *g = jobject();
        jset(g, "seed", jint(r->seed));
        jset(g, "score", jint(r->score));
        jset(g, "maxTile", jint(r->max_tile));
        jset(g, "moveCount", jint(r->move_count));
        jset(g, "over", jbool(r->over));
        jset(g, "historyHash", jstring(r->history_hash));
        jset(g, "wallMs", jdouble(r->wall_ms));
        jset(g, "nodes", jint(r->nodes));
        jpush(garr, g);
    }
    jset(res, "games", garr);
    double rates[3];
    jset(res, "summary",
         summarise(games, count, wall_ms, &cpu_ok, cpu1 - cpu0, &peak_ok, peak,
                   suite->time_decisions ? &decisions : NULL, &out->total_moves, &out->max_score, rates));
    jset(res, "checksum", jstring(out->checksum));

    out->games = games;
    out->n_games = count;
    out->total_score = total_score;
    out->json = res;
    out->wall_ms = wall_ms;
    out->games_per_sec = rates[0];
    out->moves_per_sec = rates[1];
    out->nodes_per_sec = rates[2];
    free(decisions.v);
    agent_free(agent);
    return 0;
}

void bench_result_free(bench_result_t *r) {
    free(r->games);
    json_free(r->json);
    r->games = NULL;
    r->json = NULL;
}
