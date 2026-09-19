#include "g2048/json.hpp"

#include <charconv>
#include <cmath>
#include <fstream>
#include <limits>
#include <sstream>

namespace g2048::json {

// ---------------------------------------------------------------- Object

Object::Object() = default;
Object::Object(const Object&) = default;
Object::Object(Object&&) noexcept = default;
Object& Object::operator=(const Object&) = default;
Object& Object::operator=(Object&&) noexcept = default;
Object::~Object() = default;

Object::Object(std::initializer_list<Member> members) {
  for (const auto& m : members) set(m.first, m.second);
}

bool Object::empty() const noexcept { return members_.empty(); }
std::size_t Object::size() const noexcept { return members_.size(); }
Object::const_iterator Object::begin() const noexcept { return members_.begin(); }
Object::const_iterator Object::end() const noexcept { return members_.end(); }

const Value* Object::find(std::string_view key) const {
  for (const auto& [k, v] : members_) {
    if (k == key) return &v;
  }
  return nullptr;
}

Value* Object::find(std::string_view key) {
  for (auto& [k, v] : members_) {
    if (k == key) return &v;
  }
  return nullptr;
}

const Value& Object::at(std::string_view key) const {
  if (const Value* v = find(key)) return *v;
  throw Error("missing key \"" + std::string(key) + "\"");
}

Value& Object::set(std::string key, Value v) {
  if (Value* existing = find(key)) {
    *existing = std::move(v);
    return *existing;
  }
  members_.push_back(Member{std::move(key), std::move(v)});
  return members_.back().second;
}

// ---------------------------------------------------------------- Value

namespace {

const char* type_name(const Value::Storage& s) {
  switch (s.index()) {
    case 0: return "null";
    case 1: return "bool";
    case 2:
    case 3: return "number";
    case 4: return "string";
    case 5: return "array";
    default: return "object";
  }
}

[[noreturn]] void type_error(const Value::Storage& s, const char* want) {
  throw Error(std::string("expected ") + want + ", got " + type_name(s));
}

}  // namespace

bool Value::as_bool() const {
  if (const auto* b = std::get_if<bool>(&v_)) return *b;
  type_error(v_, "bool");
}

double Value::as_double() const {
  if (const auto* i = std::get_if<std::int64_t>(&v_)) return static_cast<double>(*i);
  if (const auto* d = std::get_if<double>(&v_)) return *d;
  type_error(v_, "number");
}

std::int64_t Value::as_int() const {
  if (const auto* i = std::get_if<std::int64_t>(&v_)) return *i;
  if (const auto* d = std::get_if<double>(&v_)) {
    if (std::isfinite(*d) && std::trunc(*d) == *d && std::fabs(*d) < 9.2e18) return static_cast<std::int64_t>(*d);
    throw Error("expected integer, got " + format_number(*d));
  }
  type_error(v_, "integer");
}

std::uint32_t Value::as_u32() const {
  std::int64_t i = as_int();
  if (i < 0 || i > 0xFFFFFFFFLL) throw Error("value out of uint32 range: " + std::to_string(i));
  return static_cast<std::uint32_t>(i);
}

const std::string& Value::as_string() const {
  if (const auto* s = std::get_if<std::string>(&v_)) return *s;
  type_error(v_, "string");
}

const Array& Value::as_array() const {
  if (const auto* a = std::get_if<Array>(&v_)) return *a;
  type_error(v_, "array");
}

const Object& Value::as_object() const {
  if (const auto* o = std::get_if<Object>(&v_)) return *o;
  type_error(v_, "object");
}

Object& Value::as_object() {
  if (auto* o = std::get_if<Object>(&v_)) return *o;
  type_error(v_, "object");
}

const Value* Value::get(std::string_view key) const {
  if (const auto* o = std::get_if<Object>(&v_)) return o->find(key);
  return nullptr;
}

// ---------------------------------------------------------------- serializer

std::string format_number(double d) {
  if (!std::isfinite(d)) return "null";  // JSON has no representation; Go would error
  char buf[64];
  double a = std::fabs(d);
  bool sci = a != 0 && (a < 1e-6 || a >= 1e21);
  auto res = std::to_chars(buf, buf + sizeof buf, d, sci ? std::chars_format::scientific : std::chars_format::fixed);
  std::string s(buf, res.ptr);
  if (sci) {
    // Go cleans up e-09 to e-9 and e+09 to e+9.
    auto e = s.find('e');
    if (e != std::string::npos && e + 3 < s.size() + 1 && s.size() - e == 4 && s[e + 2] == '0') {
      s.erase(e + 2, 1);
    }
  }
  return s;
}

std::string quote(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 2);
  out.push_back('"');
  static constexpr char hex[] = "0123456789abcdef";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '<':
      case '>':
      case '&':  // Go escapes HTML-sensitive characters
        out += "\\u00";
        out.push_back(hex[c >> 4]);
        out.push_back(hex[c & 0xf]);
        break;
      default:
        if (c < 0x20) {
          out += "\\u00";
          out.push_back(hex[c >> 4]);
          out.push_back(hex[c & 0xf]);
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
  return out;
}

namespace {

void newline(std::string& out, int indent, int level) {
  if (indent <= 0) return;
  out.push_back('\n');
  out.append(static_cast<std::size_t>(indent * level), ' ');
}

void write(std::string& out, const Value& v, int indent, int level) {
  std::visit(
      [&](const auto& x) {
        using T = std::decay_t<decltype(x)>;
        if constexpr (std::is_same_v<T, std::nullptr_t>) {
          out += "null";
        } else if constexpr (std::is_same_v<T, bool>) {
          out += x ? "true" : "false";
        } else if constexpr (std::is_same_v<T, std::int64_t>) {
          out += std::to_string(x);
        } else if constexpr (std::is_same_v<T, double>) {
          out += format_number(x);
        } else if constexpr (std::is_same_v<T, std::string>) {
          out += quote(x);
        } else if constexpr (std::is_same_v<T, Array>) {
          if (x.empty()) {
            out += "[]";
            return;
          }
          out.push_back('[');
          bool first = true;
          for (const auto& e : x) {
            if (!first) out.push_back(',');
            first = false;
            newline(out, indent, level + 1);
            write(out, e, indent, level + 1);
          }
          newline(out, indent, level);
          out.push_back(']');
        } else {
          if (x.empty()) {
            out += "{}";
            return;
          }
          out.push_back('{');
          bool first = true;
          for (const auto& [k, e] : x) {
            if (!first) out.push_back(',');
            first = false;
            newline(out, indent, level + 1);
            out += quote(k);
            out += indent > 0 ? ": " : ":";
            write(out, e, indent, level + 1);
          }
          newline(out, indent, level);
          out.push_back('}');
        }
      },
      v.storage());
}

}  // namespace

std::string Value::dump() const {
  std::string out;
  write(out, *this, 0, 0);
  return out;
}

std::string Value::dump(int indent) const {
  std::string out;
  write(out, *this, indent, 0);
  return out;
}

// ---------------------------------------------------------------- parser

namespace {

class Parser {
 public:
  explicit Parser(std::string_view text) : s_(text) {}

  Value document() {
    Value v = value(0);
    skip_ws();
    if (pos_ != s_.size()) fail("trailing characters");
    return v;
  }

 private:
  static constexpr int kMaxDepth = 512;
  std::string_view s_;
  std::size_t pos_ = 0;

  [[noreturn]] void fail(const std::string& msg) const {
    throw Error("JSON parse error at offset " + std::to_string(pos_) + ": " + msg);
  }

  void skip_ws() {
    while (pos_ < s_.size() && (s_[pos_] == ' ' || s_[pos_] == '\t' || s_[pos_] == '\n' || s_[pos_] == '\r')) ++pos_;
  }

  char peek() {
    skip_ws();
    if (pos_ >= s_.size()) fail("unexpected end of input");
    return s_[pos_];
  }

  void expect(char c) {
    if (peek() != c) fail(std::string("expected '") + c + "'");
    ++pos_;
  }

  void literal(std::string_view word) {
    if (s_.substr(pos_, word.size()) != word) fail("invalid literal");
    pos_ += word.size();
  }

  Value value(int depth) {
    if (depth > kMaxDepth) fail("nesting too deep");
    switch (peek()) {
      case '{': return object(depth);
      case '[': return array(depth);
      case '"': return Value(string());
      case 't': literal("true"); return Value(true);
      case 'f': literal("false"); return Value(false);
      case 'n': literal("null"); return Value(nullptr);
      default: return number();
    }
  }

  Value object(int depth) {
    expect('{');
    Object o;
    if (peek() == '}') {
      ++pos_;
      return Value(std::move(o));
    }
    for (;;) {
      if (peek() != '"') fail("expected object key");
      std::string key = string();
      expect(':');
      o.set(std::move(key), value(depth + 1));
      char c = peek();
      ++pos_;
      if (c == '}') break;
      if (c != ',') fail("expected ',' or '}'");
    }
    return Value(std::move(o));
  }

  Value array(int depth) {
    expect('[');
    Array a;
    if (peek() == ']') {
      ++pos_;
      return Value(std::move(a));
    }
    for (;;) {
      a.push_back(value(depth + 1));
      char c = peek();
      ++pos_;
      if (c == ']') break;
      if (c != ',') fail("expected ',' or ']'");
    }
    return Value(std::move(a));
  }

  static void put_utf8(std::string& out, std::uint32_t cp) {
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  std::uint32_t hex4() {
    if (pos_ + 4 > s_.size()) fail("truncated \\u escape");
    std::uint32_t v = 0;
    for (int i = 0; i < 4; ++i) {
      char c = s_[pos_++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= static_cast<std::uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') v |= static_cast<std::uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= static_cast<std::uint32_t>(c - 'A' + 10);
      else fail("invalid \\u escape");
    }
    return v;
  }

  std::string string() {
    ++pos_;  // opening quote
    std::string out;
    for (;;) {
      if (pos_ >= s_.size()) fail("unterminated string");
      char c = s_[pos_++];
      if (c == '"') break;
      if (static_cast<unsigned char>(c) < 0x20) fail("control character in string");
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (pos_ >= s_.size()) fail("unterminated escape");
      char e = s_[pos_++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          std::uint32_t cp = hex4();
          if (cp >= 0xD800 && cp < 0xDC00 && s_.substr(pos_, 2) == "\\u") {
            std::size_t save = pos_;
            pos_ += 2;
            std::uint32_t lo = hex4();
            if (lo >= 0xDC00 && lo < 0xE000) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            } else {
              pos_ = save;
              cp = 0xFFFD;
            }
          } else if (cp >= 0xD800 && cp < 0xE000) {
            cp = 0xFFFD;
          }
          put_utf8(out, cp);
          break;
        }
        default: fail("invalid escape");
      }
    }
    return out;
  }

  Value number() {
    std::size_t start = pos_;
    bool integral = true;
    if (pos_ < s_.size() && s_[pos_] == '-') ++pos_;
    auto digits = [&] {
      std::size_t d = pos_;
      while (pos_ < s_.size() && s_[pos_] >= '0' && s_[pos_] <= '9') ++pos_;
      return pos_ - d;
    };
    if (digits() == 0) fail("invalid value");
    if (pos_ < s_.size() && s_[pos_] == '.') {
      integral = false;
      ++pos_;
      if (digits() == 0) fail("invalid number");
    }
    if (pos_ < s_.size() && (s_[pos_] == 'e' || s_[pos_] == 'E')) {
      integral = false;
      ++pos_;
      if (pos_ < s_.size() && (s_[pos_] == '+' || s_[pos_] == '-')) ++pos_;
      if (digits() == 0) fail("invalid exponent");
    }
    const char* first = s_.data() + start;
    const char* last = s_.data() + pos_;
    if (integral) {
      std::int64_t i = 0;
      auto r = std::from_chars(first, last, i);
      if (r.ec == std::errc() && r.ptr == last) return Value(i);
    }
    double d = 0;
    auto r = std::from_chars(first, last, d);
    if (r.ec != std::errc() || r.ptr != last) fail("invalid number");
    return Value(d);
  }
};

}  // namespace

Value parse(std::string_view text) { return Parser(text).document(); }

Value parse_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw Error("open " + path + ": no such file or directory");
  std::ostringstream ss;
  ss << in.rdbuf();
  try {
    return parse(ss.str());
  } catch (const Error& e) {
    throw Error(path + ": " + e.what());
  }
}

}  // namespace g2048::json
