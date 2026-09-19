// Canonical expectimax agent (spec/AI.md) and the reference random / greedy agents.
#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "g2048/engine.hpp"
#include "g2048/json.hpp"

namespace g2048::ai {

// ---------------------------------------------------------------- bitboard (AI.md §1)

// Cell i occupies bits 4i..4i+3.
using Bitboard = std::uint64_t;

// Extracts column c as a line value (row 0 in the lowest nibble).
[[nodiscard]] std::uint16_t column(Bitboard b, int c) noexcept;
// Applies dir (saturating at rank 15). Returns the new board (== b if invalid).
[[nodiscard]] Bitboard move(Bitboard b, int dir) noexcept;
// Converts a game board, clamping exponents above 15.
[[nodiscard]] Bitboard from_board(const Board& board) noexcept;
[[nodiscard]] Board to_board(Bitboard b) noexcept;
// Number of distinct non-zero ranks.
[[nodiscard]] int distinct_ranks(Bitboard b) noexcept;

// ---------------------------------------------------------------- heuristic (AI.md §2)

struct Weights {
  std::int64_t lost = 0, empty = 0, merges = 0, mono = 0, sum = 0, smooth = 0, stable = 0, corner = 0;
  friend auto operator<=>(const Weights&, const Weights&) = default;
  [[nodiscard]] json::Value to_json() const;
};

inline constexpr Weights kHeuristicV1{200000, 270, 700, 47, 11, 0, 0, 0};

struct LineFeatures {
  std::int64_t empty = 0, merges = 0, mono = 0, sum = 0, smooth = 0, stable = 0;
  friend bool operator==(const LineFeatures&, const LineFeatures&) = default;
  [[nodiscard]] json::Object to_json() const;
};

using LineTable = std::array<double, 65536>;

[[nodiscard]] LineFeatures features(std::uint16_t line) noexcept;
[[nodiscard]] std::int64_t line_score(const LineFeatures& f, const Weights& w) noexcept;
// Memoised 65536-entry per-line score table (shared, never freed).
[[nodiscard]] const LineTable& line_table(const Weights& w);
// W.corner * maxRank if a corner holds the max rank, else 0.
[[nodiscard]] double corner_term(Bitboard b, std::int64_t corner_weight) noexcept;
[[nodiscard]] double evaluate(Bitboard b, const LineTable& t, std::int64_t corner_weight) noexcept;

struct Breakdown {
  LineFeatures lines;  // summed over all 8 lines
  double corner = 0;
  double total = 0;
  [[nodiscard]] json::Value to_json() const;
};

[[nodiscard]] Breakdown heuristic_breakdown(Bitboard b, const Weights& w);

// ---------------------------------------------------------------- search (AI.md §3)

struct Config {
  // auto_depth selects depth = clamp(distinct-2, min_depth, max_depth); otherwise depth is fixed.
  bool auto_depth = true;
  int depth = 0;
  int min_depth = 2;
  int max_depth = 4;
  int four_prune_empties = 0;
  // > 0 enables iterative deepening (non-deterministic).
  double time_budget_ms = 0;
  // log2 of the transposition-table slot count.
  int tt_bits = 20;
  Weights weights = kHeuristicV1;

  [[nodiscard]] static Config canonical() { return Config{}; }
  // Overlays a JSON config object onto the canonical profile; throws std::invalid_argument.
  [[nodiscard]] static Config parse(const json::Object* config);
  [[nodiscard]] json::Value to_json() const;
};

struct SearchResult {
  int move = -1;  // -1 if no valid move
  double value = 0;
  std::array<std::optional<double>, 4> values{};
  int depth = 0;
  std::int64_t nodes = 0;
  std::int64_t tt_hits = 0;
  std::int64_t tt_size = 0;
  std::int64_t time_us = 0;
  bool deterministic = true;
  std::vector<int> completed_depths;
};

// Exact-key (board, depth) transposition table mirroring the TS reference:
// same slot hash, 4-slot linear probe, store policy and clear at 75% full.
class TranspositionTable {
 public:
  explicit TranspositionTable(int bits);

  [[nodiscard]] std::uint32_t slot(Bitboard b, int d) const noexcept {
    const auto lo = static_cast<std::uint32_t>(b);
    const auto hi = static_cast<std::uint32_t>(b >> 32);
    std::uint32_t h = ((lo ^ (static_cast<std::uint32_t>(d) * 0x9e3779b1u)) * 0x85ebca6bu) ^ (hi * 0xc2b2ae35u);
    h ^= h >> 15;
    h *= 0x2c1b3c6du;
    h ^= h >> 12;
    return h & mask_;
  }

  // Looks up (b, d); returns true and sets out on a hit.
  bool lookup(Bitboard b, int d, std::uint32_t home, double& out) const noexcept {
    std::uint32_t s = home;
    for (int probe = 0; probe < 4; ++probe) {
      const Entry& e = entries_[s];
      if (e.depth == 0) return false;
      if (e.depth == d && e.board == b) {
        out = e.value;
        return true;
      }
      s = (s + 1) & mask_;
    }
    return false;
  }

  void store(Bitboard b, int d, std::uint32_t home, double v) noexcept {
    std::uint32_t target = home;
    std::uint32_t s = home;
    for (int probe = 0; probe < 4; ++probe) {
      if (entries_[s].depth == 0) {
        target = s;
        ++size_;
        break;
      }
      s = (s + 1) & mask_;
    }
    Entry& e = entries_[target];
    e.board = b;
    e.value = v;
    e.depth = static_cast<std::uint8_t>(d);
  }

  void clear() noexcept;
  [[nodiscard]] std::int64_t size() const noexcept { return size_; }
  [[nodiscard]] std::size_t capacity() const noexcept { return static_cast<std::size_t>(mask_) + 1; }

 private:
  struct Entry {
    Bitboard board;
    double value;
    std::uint8_t depth;  // 0 = empty
  };
  std::uint32_t mask_;
  std::unique_ptr<Entry[]> entries_;
  std::int64_t size_ = 0;
};

// Reusable expectimax searcher (not thread-safe).
class Search {
 public:
  explicit Search(Config c);

  [[nodiscard]] SearchResult run(Bitboard b);
  [[nodiscard]] int depth_for(Bitboard b) const noexcept;
  [[nodiscard]] double evaluate(Bitboard b) const noexcept { return ai::evaluate(b, *table_, corner_); }
  [[nodiscard]] const Config& config() const noexcept { return config_; }

 private:
  struct RootResult {
    int move = -1;
    double value = 0;
    std::array<std::optional<double>, 4> values{};
  };

  double maxnode(Bitboard b, int d);
  double chance(Bitboard b, int d);
  bool root(Bitboard b, int depth, RootResult& out);

  Config config_;
  const LineTable* table_;
  std::int64_t corner_;
  TranspositionTable tt_;
  std::int64_t nodes_ = 0;
  std::int64_t tt_hits_ = 0;
  std::chrono::steady_clock::time_point deadline_{};
  bool timed_ = false;
  bool aborted_ = false;
};

// ---------------------------------------------------------------- agents

// Per-decision metrics (AI.md §4).
struct Metrics {
  std::optional<int> depth;
  std::optional<std::int64_t> nodes;
  std::optional<std::int64_t> tt_hits;
  std::optional<std::int64_t> tt_size;
  std::int64_t time_us = 0;
  std::optional<std::array<std::optional<double>, 4>> values;
  std::optional<Breakdown> heuristic;
  bool deterministic = true;
  std::vector<int> completed_depths;
  [[nodiscard]] json::Value to_json() const;
};

struct Decision {
  int move = -1;
  Metrics metrics;
};

class Agent {
 public:
  virtual ~Agent() = default;
  [[nodiscard]] virtual std::string_view id() const = 0;
  // Called once per game before the first decision.
  virtual void reset(std::uint32_t seed) = 0;
  // Returns a valid move; only called when at least one move is valid.
  virtual Decision decide(const Board& board) = 0;
  // Effective configuration (null if none).
  [[nodiscard]] virtual json::Value config_json() const { return nullptr; }
  [[nodiscard]] virtual bool deterministic() const { return true; }
};

// SPEC §10 reference random agent.
class RandomAgent final : public Agent {
 public:
  RandomAgent() : rng_(Rng::from_seed(0)) {}
  [[nodiscard]] std::string_view id() const override { return "random"; }
  void reset(std::uint32_t seed) override { rng_ = Rng::from_seed(seed ^ 0xA5A5A5A5u); }
  Decision decide(const Board& board) override;

 private:
  Rng rng_;
};

// Maximises empty cells after the move; ties go to the lower direction.
class GreedyAgent final : public Agent {
 public:
  [[nodiscard]] std::string_view id() const override { return "greedy"; }
  void reset(std::uint32_t) override {}
  Decision decide(const Board& board) override;
};

class ExpectimaxAgent final : public Agent {
 public:
  explicit ExpectimaxAgent(Config c) : search_(std::move(c)) {}
  [[nodiscard]] std::string_view id() const override { return "expectimax"; }
  void reset(std::uint32_t) override {}
  Decision decide(const Board& board) override;
  [[nodiscard]] json::Value config_json() const override { return search_.config().to_json(); }
  [[nodiscard]] bool deterministic() const override { return !(search_.config().time_budget_ms > 0); }
  [[nodiscard]] const SearchResult& last_result() const noexcept { return last_; }

 private:
  Search search_;
  SearchResult last_;
};

// Creates a built-in agent by id ("random", "greedy", "expectimax"); throws std::invalid_argument.
[[nodiscard]] std::unique_ptr<Agent> make_agent(std::string_view id, const json::Object* config = nullptr);

[[nodiscard]] std::int64_t round_us(std::chrono::steady_clock::duration d) noexcept;

}  // namespace g2048::ai
