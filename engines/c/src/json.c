#include "json.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------- allocation ---------- */

static void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) {
        fprintf(stderr, "out of memory\n");
        exit(1);
    }
    return p;
}

static void *xrealloc(void *p, size_t n) {
    p = realloc(p, n ? n : 1);
    if (!p) {
        fprintf(stderr, "out of memory\n");
        exit(1);
    }
    return p;
}

static char *xstrdup(const char *s) {
    size_t n = strlen(s);
    char *d = xmalloc(n + 1);
    memcpy(d, s, n + 1);
    return d;
}

static jval *jnew(jtype t) {
    jval *v = xmalloc(sizeof *v);
    memset(v, 0, sizeof *v);
    v->t = t;
    return v;
}

jval *jnull(void) { return jnew(J_NULL); }
jval *jbool(int b) {
    jval *v = jnew(J_BOOL);
    v->b = b != 0;
    return v;
}
jval *jdouble(double x) {
    jval *v = jnew(J_NUM);
    v->num = x;
    return v;
}
jval *jint(int64_t x) {
    jval *v = jnew(J_NUM);
    v->num = (double)x;
    v->ival = x;
    v->is_int = 1;
    return v;
}
jval *jstring(const char *s) {
    jval *v = jnew(J_STR);
    v->str = xstrdup(s);
    return v;
}
jval *jarray(void) { return jnew(J_ARR); }
jval *jobject(void) { return jnew(J_OBJ); }

static void jgrow(jval *v) {
    if (v->n == v->cap) {
        v->cap = v->cap ? v->cap * 2 : 8;
        v->items = xrealloc(v->items, v->cap * sizeof *v->items);
        if (v->t == J_OBJ) v->keys = xrealloc(v->keys, v->cap * sizeof *v->keys);
    }
}

jval *jpush(jval *arr, jval *item) {
    jgrow(arr);
    arr->items[arr->n++] = item;
    return arr;
}

jval *jset(jval *obj, const char *key, jval *item) {
    for (size_t i = 0; i < obj->n; i++) {
        if (strcmp(obj->keys[i], key) == 0) {
            json_free(obj->items[i]);
            obj->items[i] = item;
            return obj;
        }
    }
    jgrow(obj);
    obj->keys[obj->n] = xstrdup(key);
    obj->items[obj->n++] = item;
    return obj;
}

jval *jclone(const jval *v) {
    if (!v) return NULL;
    jval *c = jnew(v->t);
    c->b = v->b;
    c->num = v->num;
    c->is_int = v->is_int;
    c->ival = v->ival;
    if (v->raw) c->raw = xstrdup(v->raw);
    if (v->str) c->str = xstrdup(v->str);
    for (size_t i = 0; i < v->n; i++) {
        if (v->t == J_OBJ)
            jset(c, v->keys[i], jclone(v->items[i]));
        else
            jpush(c, jclone(v->items[i]));
    }
    return c;
}

void json_free(jval *v) {
    if (!v) return;
    for (size_t i = 0; i < v->n; i++) {
        json_free(v->items[i]);
        if (v->keys) free(v->keys[i]);
    }
    free(v->items);
    free(v->keys);
    free(v->raw);
    free(v->str);
    free(v);
}

/* ---------- lookup ---------- */

jval *json_get(const jval *obj, const char *key) {
    if (!obj || obj->t != J_OBJ) return NULL;
    for (size_t i = obj->n; i-- > 0;) /* last duplicate wins, like Go */
        if (strcmp(obj->keys[i], key) == 0) return obj->items[i];
    return NULL;
}

jval *json_at(const jval *arr, size_t i) {
    if (!arr || (arr->t != J_ARR && arr->t != J_OBJ) || i >= arr->n) return NULL;
    return arr->items[i];
}

const char *json_str(const jval *v) { return v && v->t == J_STR ? v->str : NULL; }
double json_num(const jval *v, double dflt) { return v && v->t == J_NUM ? v->num : dflt; }
int json_is_null(const jval *v) { return !v || v->t == J_NULL; }

/* ---------- string buffer ---------- */

static void sb_reserve(sbuf *b, size_t extra) {
    if (b->n + extra + 1 > b->cap) {
        size_t c = b->cap ? b->cap : 256;
        while (c < b->n + extra + 1) c *= 2;
        b->s = xrealloc(b->s, c);
        b->cap = c;
    }
}

void sb_putc(sbuf *b, char c) {
    sb_reserve(b, 1);
    b->s[b->n++] = c;
    b->s[b->n] = 0;
}

void sb_puts(sbuf *b, const char *s) {
    size_t n = strlen(s);
    sb_reserve(b, n);
    memcpy(b->s + b->n, s, n + 1);
    b->n += n;
}

void sb_printf(sbuf *b, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n > 0) {
        sb_reserve(b, (size_t)n);
        vsnprintf(b->s + b->n, (size_t)n + 1, fmt, ap2);
        b->n += (size_t)n;
    }
    va_end(ap2);
}

void sb_free(sbuf *b) {
    free(b->s);
    b->s = NULL;
    b->n = b->cap = 0;
}

/* ---------- parser ---------- */

typedef struct {
    const char *p;
    const char *start;
    char *err;
    size_t errlen;
    int failed;
} parser;

static void perr(parser *ps, const char *msg) {
    if (!ps->failed && ps->err)
        snprintf(ps->err, ps->errlen, "json: %s at offset %ld", msg, (long)(ps->p - ps->start));
    ps->failed = 1;
}

static void skip_ws(parser *ps) {
    while (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r') ps->p++;
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int read_hex4(parser *ps, unsigned *out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        int h = hexval(ps->p[i]);
        if (h < 0) return 0;
        v = v * 16 + (unsigned)h;
    }
    ps->p += 4;
    *out = v;
    return 1;
}

static void put_utf8(sbuf *b, unsigned cp) {
    if (cp < 0x80) {
        sb_putc(b, (char)cp);
    } else if (cp < 0x800) {
        sb_putc(b, (char)(0xC0 | (cp >> 6)));
        sb_putc(b, (char)(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        sb_putc(b, (char)(0xE0 | (cp >> 12)));
        sb_putc(b, (char)(0x80 | ((cp >> 6) & 0x3F)));
        sb_putc(b, (char)(0x80 | (cp & 0x3F)));
    } else {
        sb_putc(b, (char)(0xF0 | (cp >> 18)));
        sb_putc(b, (char)(0x80 | ((cp >> 12) & 0x3F)));
        sb_putc(b, (char)(0x80 | ((cp >> 6) & 0x3F)));
        sb_putc(b, (char)(0x80 | (cp & 0x3F)));
    }
}

static char *parse_string_raw(parser *ps) {
    /* ps->p points at the opening quote */
    ps->p++;
    sbuf b = {0};
    sb_puts(&b, "");
    for (;;) {
        unsigned char c = (unsigned char)*ps->p;
        if (c == 0) {
            perr(ps, "unterminated string");
            sb_free(&b);
            return NULL;
        }
        if (c == '"') {
            ps->p++;
            return b.s;
        }
        if (c < 0x20) {
            perr(ps, "control character in string");
            sb_free(&b);
            return NULL;
        }
        if (c != '\\') {
            sb_putc(&b, (char)c);
            ps->p++;
            continue;
        }
        ps->p++;
        char e = *ps->p++;
        switch (e) {
        case '"': sb_putc(&b, '"'); break;
        case '\\': sb_putc(&b, '\\'); break;
        case '/': sb_putc(&b, '/'); break;
        case 'b': sb_putc(&b, '\b'); break;
        case 'f': sb_putc(&b, '\f'); break;
        case 'n': sb_putc(&b, '\n'); break;
        case 'r': sb_putc(&b, '\r'); break;
        case 't': sb_putc(&b, '\t'); break;
        case 'u': {
            unsigned cp;
            if (!read_hex4(ps, &cp)) {
                perr(ps, "bad \\u escape");
                sb_free(&b);
                return NULL;
            }
            if (cp >= 0xD800 && cp < 0xDC00 && ps->p[0] == '\\' && ps->p[1] == 'u') {
                const char *save = ps->p;
                unsigned lo;
                ps->p += 2;
                if (read_hex4(ps, &lo) && lo >= 0xDC00 && lo < 0xE000) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                } else {
                    ps->p = save;
                    cp = 0xFFFD;
                }
            } else if (cp >= 0xD800 && cp < 0xE000) {
                cp = 0xFFFD;
            }
            put_utf8(&b, cp);
            break;
        }
        default:
            perr(ps, "bad escape");
            sb_free(&b);
            return NULL;
        }
    }
}

static jval *parse_value(parser *ps, int depth);

static jval *parse_number(parser *ps) {
    const char *s = ps->p;
    if (*ps->p == '-') ps->p++;
    if (*ps->p == '0') {
        ps->p++;
    } else if (*ps->p >= '1' && *ps->p <= '9') {
        while (*ps->p >= '0' && *ps->p <= '9') ps->p++;
    } else {
        perr(ps, "invalid number");
        return NULL;
    }
    if (*ps->p == '.') {
        ps->p++;
        if (!(*ps->p >= '0' && *ps->p <= '9')) {
            perr(ps, "invalid number");
            return NULL;
        }
        while (*ps->p >= '0' && *ps->p <= '9') ps->p++;
    }
    if (*ps->p == 'e' || *ps->p == 'E') {
        ps->p++;
        if (*ps->p == '+' || *ps->p == '-') ps->p++;
        if (!(*ps->p >= '0' && *ps->p <= '9')) {
            perr(ps, "invalid number");
            return NULL;
        }
        while (*ps->p >= '0' && *ps->p <= '9') ps->p++;
    }
    size_t n = (size_t)(ps->p - s);
    jval *v = jnew(J_NUM);
    v->raw = xmalloc(n + 1);
    memcpy(v->raw, s, n);
    v->raw[n] = 0;
    v->num = strtod(v->raw, NULL);
    return v;
}

static jval *parse_value(parser *ps, int depth) {
    if (depth > 512) {
        perr(ps, "nesting too deep");
        return NULL;
    }
    skip_ws(ps);
    char c = *ps->p;
    if (c == '{') {
        ps->p++;
        jval *o = jobject();
        skip_ws(ps);
        if (*ps->p == '}') {
            ps->p++;
            return o;
        }
        for (;;) {
            skip_ws(ps);
            if (*ps->p != '"') {
                perr(ps, "expected object key");
                json_free(o);
                return NULL;
            }
            char *k = parse_string_raw(ps);
            if (!k) {
                json_free(o);
                return NULL;
            }
            skip_ws(ps);
            if (*ps->p != ':') {
                perr(ps, "expected ':'");
                free(k);
                json_free(o);
                return NULL;
            }
            ps->p++;
            jval *item = parse_value(ps, depth + 1);
            if (!item) {
                free(k);
                json_free(o);
                return NULL;
            }
            jgrow(o);
            o->keys[o->n] = k;
            o->items[o->n++] = item;
            skip_ws(ps);
            if (*ps->p == ',') {
                ps->p++;
                continue;
            }
            if (*ps->p == '}') {
                ps->p++;
                return o;
            }
            perr(ps, "expected ',' or '}'");
            json_free(o);
            return NULL;
        }
    }
    if (c == '[') {
        ps->p++;
        jval *a = jarray();
        skip_ws(ps);
        if (*ps->p == ']') {
            ps->p++;
            return a;
        }
        for (;;) {
            jval *item = parse_value(ps, depth + 1);
            if (!item) {
                json_free(a);
                return NULL;
            }
            jpush(a, item);
            skip_ws(ps);
            if (*ps->p == ',') {
                ps->p++;
                continue;
            }
            if (*ps->p == ']') {
                ps->p++;
                return a;
            }
            perr(ps, "expected ',' or ']'");
            json_free(a);
            return NULL;
        }
    }
    if (c == '"') {
        char *s = parse_string_raw(ps);
        if (!s) return NULL;
        jval *v = jnew(J_STR);
        v->str = s;
        return v;
    }
    if (strncmp(ps->p, "true", 4) == 0) {
        ps->p += 4;
        return jbool(1);
    }
    if (strncmp(ps->p, "false", 5) == 0) {
        ps->p += 5;
        return jbool(0);
    }
    if (strncmp(ps->p, "null", 4) == 0) {
        ps->p += 4;
        return jnull();
    }
    if (c == '-' || (c >= '0' && c <= '9')) return parse_number(ps);
    perr(ps, "unexpected character");
    return NULL;
}

jval *json_parse(const char *text, char *err, size_t errlen) {
    parser ps = {text, text, err, errlen, 0};
    jval *v = parse_value(&ps, 0);
    if (!v) return NULL;
    skip_ws(&ps);
    if (*ps.p) {
        perr(&ps, "trailing data");
        json_free(v);
        return NULL;
    }
    return v;
}

jval *json_load(const char *path, char *err, size_t errlen) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        if (err) snprintf(err, errlen, "open %s: No such file or directory", path);
        return NULL;
    }
    sbuf b = {0};
    char buf[65536];
    size_t n;
    sb_puts(&b, "");
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) {
        sb_reserve(&b, n);
        memcpy(b.s + b.n, buf, n);
        b.n += n;
        b.s[b.n] = 0;
    }
    fclose(f);
    char perrbuf[256] = {0};
    jval *v = json_parse(b.s, perrbuf, sizeof perrbuf);
    if (!v && err) snprintf(err, errlen, "%s: %s", path, perrbuf);
    sb_free(&b);
    return v;
}

/* ---------- writer ---------- */

void json_fmt_double(double x, char *out, size_t outlen) {
    if (isnan(x) || isinf(x)) { /* not representable in JSON */
        snprintf(out, outlen, "null");
        return;
    }
    if (x == 0) {
        snprintf(out, outlen, signbit(x) ? "-0" : "0");
        return;
    }
    /* shortest %.*e that round-trips */
    char e[40];
    int prec;
    for (prec = 0; prec < 17; prec++) {
        snprintf(e, sizeof e, "%.*e", prec, x);
        if (strtod(e, NULL) == x) break;
    }
    /* split into sign, digits and exponent */
    const char *p = e;
    int neg = 0;
    if (*p == '-') {
        neg = 1;
        p++;
    }
    char digits[40];
    int nd = 0;
    while (*p && *p != 'e') {
        if (*p != '.') digits[nd++] = *p;
        p++;
    }
    while (nd > 1 && digits[nd - 1] == '0') nd--; /* trim trailing zeros */
    digits[nd] = 0;
    int exp10 = atoi(p + 1); /* value = d.ddd * 10^exp10 */
    double ax = fabs(x);
    char buf[400];
    size_t k = 0;
    if (neg) buf[k++] = '-';
    if (ax < 1e-6 || ax >= 1e21) {
        buf[k++] = digits[0];
        if (nd > 1) {
            buf[k++] = '.';
            for (int i = 1; i < nd; i++) buf[k++] = digits[i];
        }
        k += (size_t)snprintf(buf + k, sizeof buf - k, "e%c%0*d", exp10 < 0 ? '-' : '+', exp10 < 0 ? 1 : 2,
                              exp10 < 0 ? -exp10 : exp10);
    } else if (exp10 < 0) {
        buf[k++] = '0';
        buf[k++] = '.';
        for (int i = 0; i < -exp10 - 1; i++) buf[k++] = '0';
        for (int i = 0; i < nd; i++) buf[k++] = digits[i];
    } else {
        for (int i = 0; i <= exp10 || i < nd; i++) {
            if (i == exp10 + 1) buf[k++] = '.';
            buf[k++] = i < nd ? digits[i] : '0';
        }
    }
    buf[k] = 0;
    snprintf(out, outlen, "%s", buf);
}

void json_quote(sbuf *out, const char *s) {
    static const char hex[] = "0123456789abcdef";
    sb_putc(out, '"');
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        switch (c) {
        case '"': sb_puts(out, "\\\""); break;
        case '\\': sb_puts(out, "\\\\"); break;
        case '\n': sb_puts(out, "\\n"); break;
        case '\r': sb_puts(out, "\\r"); break;
        case '\t': sb_puts(out, "\\t"); break;
        default:
            if (c < 0x20 || c == '<' || c == '>' || c == '&') { /* Go escapes HTML chars too */
                sb_puts(out, "\\u00");
                sb_putc(out, hex[c >> 4]);
                sb_putc(out, hex[c & 15]);
            } else {
                sb_putc(out, (char)c);
            }
        }
    }
    sb_putc(out, '"');
}

static void newline(sbuf *out, int indent, int level) {
    if (indent < 0) return;
    sb_putc(out, '\n');
    for (int i = 0; i < indent * level; i++) sb_putc(out, ' ');
}

static void write_rec(sbuf *out, const jval *v, int indent, int level) {
    char num[64];
    switch (v->t) {
    case J_NULL: sb_puts(out, "null"); break;
    case J_BOOL: sb_puts(out, v->b ? "true" : "false"); break;
    case J_NUM:
        if (v->raw) {
            sb_puts(out, v->raw);
        } else if (v->is_int) {
            sb_printf(out, "%lld", (long long)v->ival);
        } else {
            json_fmt_double(v->num, num, sizeof num);
            sb_puts(out, num);
        }
        break;
    case J_STR: json_quote(out, v->str); break;
    case J_ARR:
    case J_OBJ: {
        int obj = v->t == J_OBJ;
        sb_putc(out, obj ? '{' : '[');
        if (v->n == 0) {
            sb_putc(out, obj ? '}' : ']');
            break;
        }
        for (size_t i = 0; i < v->n; i++) {
            if (i) sb_putc(out, ',');
            newline(out, indent, level + 1);
            if (obj) {
                json_quote(out, v->keys[i]);
                sb_puts(out, indent < 0 ? ":" : ": ");
            }
            write_rec(out, v->items[i], indent, level + 1);
        }
        newline(out, indent, level);
        sb_putc(out, obj ? '}' : ']');
        break;
    }
    }
}

void json_write(sbuf *out, const jval *v, int indent) {
    if (!out->s) sb_puts(out, "");
    write_rec(out, v, indent, 0);
}
