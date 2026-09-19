package dev.g2048.json;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON parser / writer (JDK only).
 *
 * <p>Parsed values: {@code Map<String,Object>} (insertion-ordered), {@code List<Object>},
 * {@code String}, {@code Long} (integral literals that fit), {@code Double} (everything else
 * numeric), {@code Boolean}, and {@code null}.
 *
 * <p>Written values additionally accept any {@code Number}, arrays of primitives are not
 * supported. {@link Raw} embeds pre-serialised JSON. Floating-point numbers are formatted like
 * Go's {@code encoding/json} (shortest round-trip representation, integral values without a
 * fraction, exponent form outside [1e-6, 1e21)).
 */
public final class Json {
  private Json() {}

  /** Pre-serialised JSON fragment. */
  public record Raw(String json) {}

  // ---------------------------------------------------------------- parsing

  public static Object parse(String s) {
    Parser p = new Parser(s);
    p.ws();
    Object v = p.value();
    p.ws();
    if (p.i != s.length()) throw p.err("trailing characters");
    return v;
  }

  private static final class Parser {
    final String s;
    int i;

    Parser(String s) {
      this.s = s;
    }

    IllegalArgumentException err(String msg) {
      return new IllegalArgumentException("invalid JSON at offset " + i + ": " + msg);
    }

    void ws() {
      while (i < s.length()) {
        char c = s.charAt(i);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
        else break;
      }
    }

    void expect(char c) {
      if (i >= s.length() || s.charAt(i) != c) throw err("expected '" + c + "'");
      i++;
    }

    Object value() {
      if (i >= s.length()) throw err("unexpected end");
      char c = s.charAt(i);
      return switch (c) {
        case '{' -> object();
        case '[' -> array();
        case '"' -> string();
        case 't' -> literal("true", Boolean.TRUE);
        case 'f' -> literal("false", Boolean.FALSE);
        case 'n' -> literal("null", null);
        default -> {
          if (c == '-' || (c >= '0' && c <= '9')) yield number();
          throw err("unexpected character '" + c + "'");
        }
      };
    }

    Object literal(String word, Object v) {
      if (!s.startsWith(word, i)) throw err("expected " + word);
      i += word.length();
      return v;
    }

    Map<String, Object> object() {
      expect('{');
      Map<String, Object> m = new LinkedHashMap<>();
      ws();
      if (i < s.length() && s.charAt(i) == '}') {
        i++;
        return m;
      }
      while (true) {
        ws();
        String k = string();
        ws();
        expect(':');
        ws();
        m.put(k, value());
        ws();
        if (i < s.length() && s.charAt(i) == ',') {
          i++;
          continue;
        }
        expect('}');
        return m;
      }
    }

    List<Object> array() {
      expect('[');
      List<Object> l = new ArrayList<>();
      ws();
      if (i < s.length() && s.charAt(i) == ']') {
        i++;
        return l;
      }
      while (true) {
        ws();
        l.add(value());
        ws();
        if (i < s.length() && s.charAt(i) == ',') {
          i++;
          continue;
        }
        expect(']');
        return l;
      }
    }

    String string() {
      expect('"');
      StringBuilder sb = new StringBuilder();
      while (true) {
        if (i >= s.length()) throw err("unterminated string");
        char c = s.charAt(i++);
        if (c == '"') return sb.toString();
        if (c != '\\') {
          sb.append(c);
          continue;
        }
        if (i >= s.length()) throw err("bad escape");
        char e = s.charAt(i++);
        switch (e) {
          case '"', '\\', '/' -> sb.append(e);
          case 'b' -> sb.append('\b');
          case 'f' -> sb.append('\f');
          case 'n' -> sb.append('\n');
          case 'r' -> sb.append('\r');
          case 't' -> sb.append('\t');
          case 'u' -> {
            if (i + 4 > s.length()) throw err("bad unicode escape");
            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
            i += 4;
          }
          default -> throw err("bad escape '\\" + e + "'");
        }
      }
    }

    Object number() {
      int start = i;
      boolean integral = true;
      if (s.charAt(i) == '-') i++;
      while (i < s.length()) {
        char c = s.charAt(i);
        if (c >= '0' && c <= '9') i++;
        else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
          integral = false;
          i++;
        } else break;
      }
      String t = s.substring(start, i);
      try {
        if (integral && t.length() <= 18) return Long.parseLong(t);
        return Double.parseDouble(t);
      } catch (NumberFormatException ex) {
        throw err("bad number '" + t + "'");
      }
    }
  }

  // ---------------------------------------------------------------- accessors

  @SuppressWarnings("unchecked")
  public static Map<String, Object> obj(Object o) {
    if (o instanceof Map<?, ?> m) return (Map<String, Object>) m;
    throw new IllegalArgumentException("expected JSON object");
  }

  @SuppressWarnings("unchecked")
  public static List<Object> arr(Object o) {
    if (o instanceof List<?> l) return (List<Object>) l;
    throw new IllegalArgumentException("expected JSON array");
  }

  public static long lng(Object o) {
    if (o instanceof Long l) return l;
    if (o instanceof Double d && d == Math.rint(d)) return d.longValue();
    throw new IllegalArgumentException("expected integer, got " + o);
  }

  public static double dbl(Object o) {
    if (o instanceof Number n) return n.doubleValue();
    throw new IllegalArgumentException("expected number, got " + o);
  }

  public static String str(Object o) {
    if (o instanceof String s) return s;
    throw new IllegalArgumentException("expected string, got " + o);
  }

  public static boolean bool(Object o) {
    if (o instanceof Boolean b) return b;
    throw new IllegalArgumentException("expected boolean, got " + o);
  }

  // ---------------------------------------------------------------- writing

  /** Compact serialisation. */
  public static String write(Object v) {
    StringBuilder sb = new StringBuilder();
    write(sb, v, null, 0);
    return sb.toString();
  }

  /** Indented serialisation (like Go's MarshalIndent). */
  public static String writeIndent(Object v, String indent) {
    StringBuilder sb = new StringBuilder();
    write(sb, v, indent, 0);
    return sb.toString();
  }

  private static void newline(StringBuilder sb, String indent, int level) {
    if (indent == null) return;
    sb.append('\n');
    for (int k = 0; k < level; k++) sb.append(indent);
  }

  private static void write(StringBuilder sb, Object v, String indent, int level) {
    switch (v) {
      case null -> sb.append("null");
      case Raw r -> {
        if (indent == null) sb.append(r.json());
        else write(sb, parse(r.json()), indent, level);
      }
      case String s -> quote(sb, s);
      case Boolean b -> sb.append(b);
      case Double d -> sb.append(formatDouble(d));
      case Float f -> sb.append(formatDouble(f));
      case Number n -> sb.append(n.longValue());
      case Map<?, ?> m -> {
        if (m.isEmpty()) {
          sb.append("{}");
          return;
        }
        sb.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> e : m.entrySet()) {
          if (!first) sb.append(',');
          first = false;
          newline(sb, indent, level + 1);
          quote(sb, String.valueOf(e.getKey()));
          sb.append(indent == null ? ":" : ": ");
          write(sb, e.getValue(), indent, level + 1);
        }
        newline(sb, indent, level);
        sb.append('}');
      }
      case List<?> l -> {
        if (l.isEmpty()) {
          sb.append("[]");
          return;
        }
        sb.append('[');
        boolean first = true;
        for (Object x : l) {
          if (!first) sb.append(',');
          first = false;
          newline(sb, indent, level + 1);
          write(sb, x, indent, level + 1);
        }
        newline(sb, indent, level);
        sb.append(']');
      }
      default -> throw new IllegalArgumentException("cannot serialise " + v.getClass());
    }
  }

  private static void quote(StringBuilder sb, String s) {
    sb.append('"');
    for (int k = 0; k < s.length(); k++) {
      char c = s.charAt(k);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        default -> {
          if (c < 0x20 || c == '<' || c == '>' || c == '&') sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
        }
      }
    }
    sb.append('"');
  }

  /** Formats a double like Go's encoding/json (shortest round-trip). */
  public static String formatDouble(double d) {
    if (Double.isNaN(d) || Double.isInfinite(d)) throw new IllegalArgumentException("unsupported value " + d);
    if (d == 0) return (1 / d < 0) ? "-0" : "0";
    double a = Math.abs(d);
    String shortest = Double.toString(d); // shortest round-trip since JDK 19
    if (a >= 1e-6 && a < 1e21) {
      String plain = new BigDecimal(shortest).stripTrailingZeros().toPlainString();
      return plain;
    }
    // exponent form: mantissa e[+-]XX (at least two exponent digits)
    BigDecimal bd = new BigDecimal(shortest).stripTrailingZeros();
    String digits = bd.unscaledValue().abs().toString();
    int exp = digits.length() - 1 - bd.scale();
    StringBuilder sb = new StringBuilder();
    if (d < 0) sb.append('-');
    sb.append(digits.charAt(0));
    if (digits.length() > 1) sb.append('.').append(digits, 1, digits.length());
    sb.append('e').append(exp < 0 ? '-' : '+');
    int ae = Math.abs(exp);
    if (ae < 10) sb.append('0');
    sb.append(ae);
    return sb.toString();
  }
}
