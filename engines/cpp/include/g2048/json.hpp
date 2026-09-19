// Minimal JSON value type, parser and serializer (standard library only).
#pragma once

#include <cstdint>
#include <initializer_list>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace g2048::json {

class Value;

using Array = std::vector<Value>;

struct Member;

// Object preserves insertion order (so re-serialised input keeps its key order).
// Member is completed after Value so no std::pair<.., Value> is instantiated
// while Value is incomplete.
class Object {
 public:
  using const_iterator = std::vector<Member>::const_iterator;

  Object();
  Object(std::initializer_list<Member> members);
  Object(const Object&);
  Object(Object&&) noexcept;
  Object& operator=(const Object&);
  Object& operator=(Object&&) noexcept;
  ~Object();

  [[nodiscard]] const Value* find(std::string_view key) const;
  [[nodiscard]] Value* find(std::string_view key);
  [[nodiscard]] bool contains(std::string_view key) const { return find(key) != nullptr; }
  // Throws json::Error if the key is missing.
  [[nodiscard]] const Value& at(std::string_view key) const;
  // Inserts or replaces.
  Value& set(std::string key, Value v);

  [[nodiscard]] bool empty() const noexcept;
  [[nodiscard]] std::size_t size() const noexcept;
  [[nodiscard]] const_iterator begin() const noexcept;
  [[nodiscard]] const_iterator end() const noexcept;

 private:
  std::vector<Member> members_;
};

struct Error : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class Value {
 public:
  // Integers without fraction/exponent parse as int64; everything else as double.
  using Storage = std::variant<std::nullptr_t, bool, std::int64_t, double, std::string, Array, Object>;

  Value() : v_(nullptr) {}
  Value(std::nullptr_t) : v_(nullptr) {}
  Value(bool b) : v_(b) {}
  Value(int i) : v_(static_cast<std::int64_t>(i)) {}
  Value(unsigned i) : v_(static_cast<std::int64_t>(i)) {}
  Value(long i) : v_(static_cast<std::int64_t>(i)) {}
  Value(long long i) : v_(static_cast<std::int64_t>(i)) {}
  Value(unsigned long i) : v_(static_cast<std::int64_t>(i)) {}
  Value(unsigned long long i) : v_(static_cast<std::int64_t>(i)) {}
  Value(double d) : v_(d) {}
  Value(const char* s) : v_(std::string(s)) {}
  Value(std::string s) : v_(std::move(s)) {}
  Value(std::string_view s) : v_(std::string(s)) {}
  Value(Array a) : v_(std::move(a)) {}
  Value(Object o) : v_(std::move(o)) {}

  [[nodiscard]] bool is_null() const { return std::holds_alternative<std::nullptr_t>(v_); }
  [[nodiscard]] bool is_bool() const { return std::holds_alternative<bool>(v_); }
  [[nodiscard]] bool is_int() const { return std::holds_alternative<std::int64_t>(v_); }
  [[nodiscard]] bool is_number() const { return is_int() || std::holds_alternative<double>(v_); }
  [[nodiscard]] bool is_string() const { return std::holds_alternative<std::string>(v_); }
  [[nodiscard]] bool is_array() const { return std::holds_alternative<Array>(v_); }
  [[nodiscard]] bool is_object() const { return std::holds_alternative<Object>(v_); }

  // Typed accessors; throw json::Error on type mismatch.
  [[nodiscard]] bool as_bool() const;
  [[nodiscard]] double as_double() const;
  // Accepts integers and integral doubles.
  [[nodiscard]] std::int64_t as_int() const;
  [[nodiscard]] std::uint32_t as_u32() const;
  [[nodiscard]] const std::string& as_string() const;
  [[nodiscard]] const Array& as_array() const;
  [[nodiscard]] const Object& as_object() const;
  [[nodiscard]] Object& as_object();

  // Object member lookup (throws if not an object or key missing).
  [[nodiscard]] const Value& operator[](std::string_view key) const { return as_object().at(key); }
  // Object member lookup, nullptr if absent or not an object.
  [[nodiscard]] const Value* get(std::string_view key) const;

  [[nodiscard]] const Storage& storage() const { return v_; }

  // Compact single-line form (like Go json.Marshal).
  [[nodiscard]] std::string dump() const;
  // Indented form (like Go json.MarshalIndent(v, "", indent)).
  [[nodiscard]] std::string dump(int indent) const;

 private:
  Storage v_;
};

struct Member {
  std::string first;  // key
  Value second;       // value
};

// Parses a complete JSON document; throws json::Error.
[[nodiscard]] Value parse(std::string_view text);

// Reads and parses a file; throws json::Error (including I/O errors).
[[nodiscard]] Value parse_file(const std::string& path);

// Formats a float64 like Go's encoding/json (shortest round-trip, 'f' or 'e').
[[nodiscard]] std::string format_number(double d);

// Quotes and escapes a string.
[[nodiscard]] std::string quote(std::string_view s);

}  // namespace g2048::json
