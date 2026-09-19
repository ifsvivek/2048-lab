// Canonical 2048 rules (spec/SPEC.md): RNG, board, moves, spawn, game
// lifecycle, hashes, replay verification, boardHex, replay codes and ULIDs.
#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace g2048 {

inline constexpr int kSpecVersion = 1;
inline constexpr std::string_view kEngineVersion = "1.0.0";

// ---------------------------------------------------------------- RNG (SPEC §4)

using RngState = std::array<std::uint32_t, 4>;

// Expands a seed into generator state (SPEC §4.1).
[[nodiscard]] RngState mix32(std::uint32_t seed) noexcept;

// xoshiro128** (SPEC §4.2).
class Rng {
 public:
  constexpr Rng() noexcept : s_{} {}
  explicit constexpr Rng(RngState s) noexcept : s_(s) {}
  [[nodiscard]] static Rng from_seed(std::uint32_t seed) noexcept { return Rng(mix32(seed)); }

  std::uint32_t next() noexcept {
    const std::uint32_t result = rotl(s_[1] * 5u, 7) * 9u;
    const std::uint32_t t = s_[1] << 9;
    s_[2] ^= s_[0];
    s_[3] ^= s_[1];
    s_[1] ^= s_[2];
    s_[0] ^= s_[3];
    s_[2] ^= t;
    s_[3] = rotl(s_[3], 11);
    return result;
  }

  // Unbiased integer in [0, n), 1 <= n <= 2^32 (SPEC §4.3).
  std::uint32_t below(std::uint64_t n) noexcept {
    constexpr std::uint64_t two32 = std::uint64_t{1} << 32;
    const std::uint64_t limit = two32 - two32 % n;
    for (;;) {
      const std::uint64_t x = next();
      if (x < limit) return static_cast<std::uint32_t>(x % n);
    }
  }

  [[nodiscard]] const RngState& state() const noexcept { return s_; }
  friend bool operator==(const Rng&, const Rng&) = default;

 private:
  static constexpr std::uint32_t rotl(std::uint32_t x, int k) noexcept { return (x << k) | (x >> (32 - k)); }
  RngState s_;
};

// ---------------------------------------------------------------- directions (SPEC §2)

enum Direction : int { kUp = 0, kDown = 1, kLeft = 2, kRight = 3 };

inline constexpr std::string_view kDirectionLetters = "UDLR";
inline constexpr std::array<std::string_view, 4> kDirectionNames = {"up", "down", "left", "right"};

// Accepts names ("left"), letters ("L") or digits ("2"); nullopt if invalid.
[[nodiscard]] std::optional<int> parse_direction(std::string_view s);

// ---------------------------------------------------------------- board (SPEC §1, §3, §5)

struct SpawnResult {
  int index;
  std::uint8_t exponent;
};

struct MoveResult;

// 16 exponents, row-major.
class Board {
 public:
  std::array<std::uint8_t, 16> cells{};

  // Decodes a boardHex string (case-insensitive); nullopt if malformed.
  [[nodiscard]] static std::optional<Board> from_hex(std::string_view hex);
  // Decodes boardHex, throwing std::invalid_argument on error.
  [[nodiscard]] static Board must(std::string_view hex);
  // Converts tile values (0 = empty, powers of two) as board[row][col]; throws std::invalid_argument.
  [[nodiscard]] static Board from_matrix(const std::vector<std::vector<std::int64_t>>& m);

  [[nodiscard]] std::string hex() const;
  [[nodiscard]] std::vector<std::vector<std::int64_t>> matrix() const;

  [[nodiscard]] std::uint8_t max_exponent() const noexcept;
  // Largest tile value (0 for an empty board).
  [[nodiscard]] std::int64_t max_tile() const noexcept;

  // Applies dir in place. Returns the score gained, or -1 if the move is invalid (board untouched).
  std::int64_t move_in_place(int dir) noexcept;
  // Returns the moved board, score gained and whether it changed.
  [[nodiscard]] MoveResult move(int dir) const noexcept;
  [[nodiscard]] bool can_move(int dir) const noexcept;
  [[nodiscard]] std::vector<int> valid_moves() const;
  [[nodiscard]] bool is_over() const noexcept;

  // Places a tile per SPEC §5; nullopt (and no draws) if the board is full.
  std::optional<SpawnResult> spawn(Rng& rng) noexcept;

  std::uint8_t& operator[](int i) noexcept { return cells[static_cast<std::size_t>(i)]; }
  std::uint8_t operator[](int i) const noexcept { return cells[static_cast<std::size_t>(i)]; }
  friend bool operator==(const Board&, const Board&) = default;
};

struct MoveResult {
  Board board;
  std::int64_t gained;
  bool changed;
};

// ---------------------------------------------------------------- hashes (SPEC §7)

[[nodiscard]] std::uint32_t fnv1a32(std::string_view data) noexcept;
[[nodiscard]] std::uint32_t board_hash(const Board& b) noexcept;
// fnv1a32(le32(h) ++ board ++ [dir]).
[[nodiscard]] std::uint32_t history_step(std::uint32_t h, const Board& b, int dir) noexcept;
// 8 lowercase hex digits.
[[nodiscard]] std::string hash_hex(std::uint32_t h);

// ---------------------------------------------------------------- game (SPEC §6)

struct Snapshot {
  std::uint32_t seed = 0;
  std::string board;
  std::int64_t score = 0;
  int move_count = 0;
  std::int64_t max_tile = 0;
  bool over = false;
  std::string history_hash;
};

class Game {
 public:
  explicit Game(std::uint32_t seed);

  // Applies a move; returns the score gained, or nullopt if invalid (no state change).
  std::optional<std::int64_t> apply(int dir);

  [[nodiscard]] bool over() const noexcept { return board.is_over(); }
  [[nodiscard]] std::string history_hash() const { return hash_hex(hash); }
  [[nodiscard]] const std::string& moves() const noexcept { return moves_; }
  [[nodiscard]] Snapshot snapshot() const;

  std::uint32_t seed;
  Board board;
  std::int64_t score = 0;
  int move_count = 0;
  Rng rng;
  std::uint32_t hash = 0;

 private:
  std::string moves_;
};

// ---------------------------------------------------------------- replays (SPEC §8)

inline constexpr std::string_view kErrInvalidMoveAt = "INVALID_MOVE_AT";
inline constexpr std::string_view kErrBadLetter = "BAD_LETTER";
inline constexpr std::string_view kErrSpecVersion = "SPEC_VERSION";
inline constexpr std::string_view kErrFinalMismatch = "FINAL_MISMATCH";

struct ReplayError {
  std::string code;
  std::string message;
  int move_index = -1;  // -1 when not applicable
};

// Client-claimed final values; absent fields are not checked.
struct FinalClaim {
  std::optional<std::string> board;
  std::optional<std::int64_t> score;
  std::optional<int> move_count;
  std::optional<std::string> history_hash;
};

struct SimulateResult {
  std::optional<Game> game;
  std::optional<ReplayError> error;
};

// Re-plays moves from seed.
[[nodiscard]] SimulateResult simulate(std::uint32_t seed, std::string_view moves);

struct VerifyResult {
  Snapshot snapshot;  // authoritative state (also set on FINAL_MISMATCH)
  std::optional<ReplayError> error;
  [[nodiscard]] bool ok() const noexcept { return !error.has_value(); }
};

// Re-simulates a replay and checks the claim.
[[nodiscard]] VerifyResult verify_replay(int spec_version, std::uint32_t seed, std::string_view moves,
                                         const FinalClaim* claim = nullptr);

// ---------------------------------------------------------------- identifiers (SPEC §9)

inline constexpr std::string_view kReplayAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// uint32 seed from a CSPRNG.
[[nodiscard]] std::uint32_t random_seed();
[[nodiscard]] std::string ulid(std::chrono::system_clock::time_point now = std::chrono::system_clock::now());
[[nodiscard]] bool is_ulid(std::string_view s) noexcept;
[[nodiscard]] std::string generate_replay_code();
// Upper-cases, strips non [A-Z0-9] and validates; nullopt if invalid.
[[nodiscard]] std::optional<std::string> normalize_replay_code(std::string_view input);
// XXXX-XXXX-XXXX.
[[nodiscard]] std::string format_replay_code(std::string_view normalized);

}  // namespace g2048
