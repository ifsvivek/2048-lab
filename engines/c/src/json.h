/* Minimal JSON DOM: parser, builder and (Go encoding/json compatible) writer. */
#ifndef G2048_JSON_H
#define G2048_JSON_H

#include <stddef.h>
#include <stdint.h>

typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } jtype;

typedef struct jval {
    jtype t;
    int b;             /* J_BOOL */
    double num;        /* J_NUM */
    char *raw;         /* J_NUM: original text (parsed numbers) or NULL */
    int is_int;        /* J_NUM: emit ival instead of num */
    int64_t ival;
    char *str;         /* J_STR */
    size_t n, cap;     /* J_ARR / J_OBJ */
    char **keys;       /* J_OBJ, insertion order */
    struct jval **items;
} jval;

/* Parsing. Returns NULL on error and writes a message to err (if non-NULL). */
jval *json_parse(const char *text, char *err, size_t errlen);
/* Reads and parses a file. */
jval *json_load(const char *path, char *err, size_t errlen);
void json_free(jval *v);

/* Lookup helpers (return NULL when missing / wrong type). */
jval *json_get(const jval *obj, const char *key);
jval *json_at(const jval *arr, size_t i);
const char *json_str(const jval *v);          /* NULL unless J_STR */
double json_num(const jval *v, double dflt);  /* dflt unless J_NUM */
int json_is_null(const jval *v);              /* missing or J_NULL */

/* Construction. */
jval *jnull(void);
jval *jbool(int b);
jval *jdouble(double x);
jval *jint(int64_t x);
jval *jstring(const char *s);
jval *jarray(void);
jval *jobject(void);
jval *jpush(jval *arr, jval *item);                  /* returns arr */
jval *jset(jval *obj, const char *key, jval *item);  /* returns obj */
jval *jclone(const jval *v);

/* Growable string buffer. */
typedef struct {
    char *s;
    size_t n, cap;
} sbuf;
void sb_putc(sbuf *b, char c);
void sb_puts(sbuf *b, const char *s);
void sb_printf(sbuf *b, const char *fmt, ...);
void sb_free(sbuf *b);

/* Formats a double like Go's encoding/json (shortest round-trip). */
void json_fmt_double(double x, char *out, size_t outlen);
/* Serialises v. indent < 0: compact; otherwise pretty with `indent` spaces. */
void json_write(sbuf *out, const jval *v, int indent);
/* Appends a JSON-quoted string. */
void json_quote(sbuf *out, const char *s);

#endif
