#include "g2048/engine.hpp"

#include <algorithm>
#include <cstdio>
#include <random>
#include <stdexcept>

namespace g2048 {

// ---------------------------------------------------------------- RNG

RngState mix32(std::uint32_t seed) noexcept {
  RngState s{};
  std::uint32_t x = seed;
  for (auto& word : s) {
    x += 0x9E3779B9u;
    std::uint32_t z = x;
    z = (z ^ (z >> 16)) * 0x85EBCA6Bu;
    z = (z ^ (z >> 13)) * 0xC2B2AE35u;
    word = z ^ (z >> 16);
  }
  if (s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0) s[0] = 1;
  return s;
}

// ---------------------------------------------------------------- directions

namespace {

constexpr char to_lower(char c) noexcept { return (c >= 'A' && c <= 'Z') ? static_cast<char>(c + 32) : c; }
constexpr char to_upper(char c) noexcept { return (c >= 'a' && c <= 'z') ? static_cast<char>(c - 32) : c; }

constexpr std::string_view kHexDigits = "0123456789abcdefghijklmnopqrstuvwxyz";

// kLines[dir][line][k] = cell indices starting at the edge tiles slide toward (SPEC §3).
constexpr auto kLines = [] {
  std::array<std::array<std::array<std::uint8_t, 4>, 4>, 4> l{};
  for (int k = 0; k < 4; ++k) {
    for (int j = 0; j < 4; ++j) {
      l[kUp][k][j] = static_cast<std::uint8_t>(j * 4 + k);
      l[kDown][k][j] = static_cast<std::uint8_t>((3 - j) * 4 + k);
      l[kLeft][k][j] = static_cast<std::uint8_t>(k * 4 + j);
      l[kRight][k][j] = static_cast<std::uint8_t>(k * 4 + 3 - j);
    }
  }
  return l;
}();

}  // namespace

std::optional<int> parse_direction(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\n' || s.front() == '\r')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\n' || s.back() == '\r')) s.remove_suffix(1);
  std::string t(s);
  std::transform(t.begin(), t.end(), t.begin(), to_lower);
  for (int i = 0; i < 4; ++i) {
    if (t == kDirectionNames[static_cast<std::size_t>(i)]) return i;
  }
  if (t.size() == 1) {
    if (auto p = std::string_view("udlr").find(t[0]); p != std::string_view::npos) return static_cast<int>(p);
    if (t[0] >= '0' && t[0] <= '3') return t[0] - '0';
  }
  return std::nullopt;
}

// ---------------------------------------------------------------- board

std::optional<Board> Board::from_hex(std::string_view hex) {
  if (hex.size() != 16) return std::nullopt;
  Board b;
  for (int i = 0; i < 16; ++i) {
    auto v = kHexDigits.find(to_lower(hex[static_cast<std::size_t>(i)]));
    if (v == std::string_view::npos) return std::nullopt;
    b[i] = static_cast<std::uint8_t>(v);
  }
  return b;
}

Board Board::must(std::string_view hex) {
  auto b = from_hex(hex);
  if (!b) throw std::invalid_argument("invalid boardHex '" + std::string(hex) + "'");
  return *b;
}

Board Board::from_matrix(const std::vector<std::vector<std::int64_t>>& m) {
  if (m.size() != 4) throw std::invalid_argument("board must have 4 rows");
  Board b;
  for (int r = 0; r < 4; ++r) {
    const auto& row = m[static_cast<std::size_t>(r)];
    if (row.size() != 4) throw std::invalid_argument("board row " + std::to_string(r) + " must have 4 cells");
    for (int c = 0; c < 4; ++c) {
      std::int64_t v = row[static_cast<std::size_t>(c)];
      if (v == 0) continue;
      if (v < 2 || (v & (v - 1)) != 0) throw std::invalid_argument("invalid tile value " + std::to_string(v));
      int e = 0;
      while (v > 1) {
        v >>= 1;
        ++e;
      }
      if (e > 35) throw std::invalid_argument("tile too large");
      b[r * 4 + c] = static_cast<std::uint8_t>(e);
    }
  }
  return b;
}

std::string Board::hex() const {
  std::string s(16, '0');
  for (int i = 0; i < 16; ++i) s[static_cast<std::size_t>(i)] = kHexDigits[(*this)[i]];
  return s;
}

std::vector<std::vector<std::int64_t>> Board::matrix() const {
  std::vector<std::vector<std::int64_t>> m(4, std::vector<std::int64_t>(4, 0));
  for (int r = 0; r < 4; ++r) {
    for (int c = 0; c < 4; ++c) {
      if (auto e = (*this)[r * 4 + c]; e != 0) m[static_cast<std::size_t>(r)][static_cast<std::size_t>(c)] = std::int64_t{1} << e;
    }
  }
  return m;
}

std::uint8_t Board::max_exponent() const noexcept { return *std::max_element(cells.begin(), cells.end()); }

std::int64_t Board::max_tile() const noexcept {
  auto e = max_exponent();
  return e == 0 ? 0 : std::int64_t{1} << e;
}

std::int64_t Board::move_in_place(int dir) noexcept {
  std::int64_t gained = 0;
  bool changed = false;
  for (const auto& idx : kLines[static_cast<std::size_t>(dir)]) {
    std::array<std::uint8_t, 4> tiles{};
    int n = 0;
    for (auto k : idx) {
      if (auto v = cells[k]; v != 0) tiles[static_cast<std::size_t>(n++)] = v;
    }
    std::array<std::uint8_t, 4> res{};
    std::size_t out = 0;
    for (int i = 0; i < n;) {
      auto a = tiles[static_cast<std::size_t>(i)];
      if (i + 1 < n && a == tiles[static_cast<std::size_t>(i + 1)]) {
        auto e = static_cast<std::uint8_t>(a + 1);
        res[out] = e;
        gained += std::int64_t{1} << e;
        i += 2;
      } else {
        res[out] = a;
        ++i;
      }
      ++out;
    }
    for (std::size_t k = 0; k < 4; ++k) {
      if (cells[idx[k]] != res[k]) {
        cells[idx[k]] = res[k];
        changed = true;
      }
    }
  }
  return changed ? gained : -1;
}

MoveResult Board::move(int dir) const noexcept {
  Board nb = *this;
  auto g = nb.move_in_place(dir);
  if (g < 0) return {*this, 0, false};
  return {nb, g, true};
}

bool Board::can_move(int dir) const noexcept {
  for (const auto& idx : kLines[static_cast<std::size_t>(dir)]) {
    for (std::size_t k = 1; k < 4; ++k) {
      auto prev = cells[idx[k - 1]];
      auto cur = cells[idx[k]];
      if (cur != 0 && (prev == 0 || prev == cur)) return true;
    }
  }
  return false;
}

std::vector<int> Board::valid_moves() const {
  std::vector<int> out;
  for (int d = 0; d < 4; ++d) {
    if (can_move(d)) out.push_back(d);
  }
  return out;
}

bool Board::is_over() const noexcept {
  for (int d = 0; d < 4; ++d) {
    if (can_move(d)) return false;
  }
  return true;
}

std::optional<SpawnResult> Board::spawn(Rng& rng) noexcept {
  std::array<std::uint8_t, 16> empties{};
  std::size_t n = 0;
  for (std::uint8_t i = 0; i < 16; ++i) {
    if (cells[i] == 0) empties[n++] = i;
  }
  if (n == 0) return std::nullopt;
  int index = empties[rng.below(n)];
  std::uint8_t exponent = rng.below(10) == 0 ? 2 : 1;
  (*this)[index] = exponent;
  return SpawnResult{index, exponent};
}

// ---------------------------------------------------------------- hashes

namespace {
constexpr std::uint32_t kFnvOffset = 0x811C9DC5u;
constexpr std::uint32_t kFnvPrime = 0x01000193u;
}  // namespace

std::uint32_t fnv1a32(std::string_view data) noexcept {
  std::uint32_t h = kFnvOffset;
  for (unsigned char c : data) h = (h ^ c) * kFnvPrime;
  return h;
}

std::uint32_t board_hash(const Board& b) noexcept {
  std::uint32_t h = kFnvOffset;
  for (auto c : b.cells) h = (h ^ c) * kFnvPrime;
  return h;
}

std::uint32_t history_step(std::uint32_t h, const Board& b, int dir) noexcept {
  std::uint32_t x = kFnvOffset;
  for (int k = 0; k < 4; ++k) x = (x ^ ((h >> (8 * k)) & 0xffu)) * kFnvPrime;
  for (auto c : b.cells) x = (x ^ c) * kFnvPrime;
  return (x ^ static_cast<std::uint32_t>(dir)) * kFnvPrime;
}

std::string hash_hex(std::uint32_t h) {
  char buf[9];
  std::snprintf(buf, sizeof buf, "%08x", h);
  return std::string(buf, 8);
}

// ---------------------------------------------------------------- game

Game::Game(std::uint32_t s) : seed(s), rng(Rng::from_seed(s)) {
  board.spawn(rng);
  board.spawn(rng);
  hash = board_hash(board);
}

std::optional<std::int64_t> Game::apply(int dir) {
  auto gained = board.move_in_place(dir);
  if (gained < 0) return std::nullopt;
  score += gained;
  ++move_count;
  board.spawn(rng);
  hash = history_step(hash, board, dir);
  moves_.push_back(kDirectionLetters[static_cast<std::size_t>(dir)]);
  return gained;
}

Snapshot Game::snapshot() const {
  return Snapshot{seed, board.hex(), score, move_count, board.max_tile(), over(), history_hash()};
}

// ---------------------------------------------------------------- replays

SimulateResult simulate(std::uint32_t seed, std::string_view moves) {
  Game g(seed);
  for (std::size_t i = 0; i < moves.size(); ++i) {
    const int at = static_cast<int>(i);
    auto d = kDirectionLetters.find(moves[i]);
    if (d == std::string_view::npos) {
      return {std::nullopt, ReplayError{std::string(kErrBadLetter),
                                        "bad move letter '" + std::string(1, moves[i]) + "' at " + std::to_string(at), at}};
    }
    if (!g.apply(static_cast<int>(d))) {
      return {std::nullopt, ReplayError{std::string(kErrInvalidMoveAt), "INVALID_MOVE_AT " + std::to_string(at), at}};
    }
  }
  return {std::move(g), std::nullopt};
}

VerifyResult verify_replay(int spec_version, std::uint32_t seed, std::string_view moves, const FinalClaim* claim) {
  if (spec_version != kSpecVersion) {
    return {{}, ReplayError{std::string(kErrSpecVersion), "unsupported specVersion " + std::to_string(spec_version), -1}};
  }
  auto sim = simulate(seed, moves);
  if (sim.error) return {{}, std::move(sim.error)};
  VerifyResult r{sim.game->snapshot(), std::nullopt};
  if (claim) {
    auto mismatch = [&](std::string_view key, const std::string& claimed, const std::string& actual) {
      r.error = ReplayError{std::string(kErrFinalMismatch),
                            "final." + std::string(key) + " mismatch: claimed " + claimed + ", actual " + actual, -1};
    };
    const auto& s = r.snapshot;
    if (claim->board && *claim->board != s.board) {
      mismatch("board", *claim->board, s.board);
    } else if (claim->score && *claim->score != s.score) {
      mismatch("score", std::to_string(*claim->score), std::to_string(s.score));
    } else if (claim->move_count && *claim->move_count != s.move_count) {
      mismatch("moveCount", std::to_string(*claim->move_count), std::to_string(s.move_count));
    } else if (claim->history_hash && *claim->history_hash != s.history_hash) {
      mismatch("historyHash", *claim->history_hash, s.history_hash);
    }
  }
  return r;
}

// ---------------------------------------------------------------- identifiers

namespace {

constexpr std::string_view kCrockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

std::vector<std::uint8_t> random_bytes(std::size_t n) {
  std::random_device rd;  // CSPRNG-backed (getrandom / /dev/urandom) on Linux
  std::vector<std::uint8_t> out(n);
  for (std::size_t i = 0; i < n; i += 4) {
    std::uint32_t w = rd();
    for (std::size_t k = 0; k < 4 && i + k < n; ++k) out[i + k] = static_cast<std::uint8_t>(w >> (8 * k));
  }
  return out;
}

}  // namespace

std::uint32_t random_seed() {
  auto b = random_bytes(4);
  return static_cast<std::uint32_t>(b[0]) | static_cast<std::uint32_t>(b[1]) << 8 |
         static_cast<std::uint32_t>(b[2]) << 16 | static_cast<std::uint32_t>(b[3]) << 24;
}

std::string ulid(std::chrono::system_clock::time_point now) {
  auto t = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count());
  std::string out(26, '0');
  for (int i = 9; i >= 0; --i) {
    out[static_cast<std::size_t>(i)] = kCrockford[t % 32];
    t /= 32;
  }
  auto rnd = random_bytes(16);
  for (std::size_t i = 0; i < 16; ++i) out[10 + i] = kCrockford[rnd[i] & 31];
  return out;
}

bool is_ulid(std::string_view s) noexcept {
  if (s.size() != 26) return false;
  return std::all_of(s.begin(), s.end(), [](char c) { return kCrockford.find(c) != std::string_view::npos; });
}

std::string generate_replay_code() {
  auto rnd = random_bytes(12);
  std::string s(12, 'A');
  for (std::size_t i = 0; i < 12; ++i) s[i] = kReplayAlphabet[rnd[i] & 31];
  return format_replay_code(s);
}

std::optional<std::string> normalize_replay_code(std::string_view input) {
  std::string s;
  for (char c : input) {
    c = to_upper(c);
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) s.push_back(c);
  }
  if (s.size() != 12) return std::nullopt;
  for (char c : s) {
    if (kReplayAlphabet.find(c) == std::string_view::npos) return std::nullopt;
  }
  return s;
}

std::string format_replay_code(std::string_view n) {
  return std::string(n.substr(0, 4)) + "-" + std::string(n.substr(4, 4)) + "-" + std::string(n.substr(8, 4));
}

}  // namespace g2048
