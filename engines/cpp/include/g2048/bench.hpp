// Benchmark-suite runner (spec/benchmarks) producing BenchmarkResult JSON
// (spec/schemas/benchmark-result.schema.json).
#pragma once

#include <cstdint>
#include <functional>
#include <iosfwd>
#include <optional>
#include <string>
#include <vector>

#include "g2048/ai.hpp"
#include "g2048/engine.hpp"
#include "g2048/json.hpp"

namespace g2048::bench {

struct Suite {
  std::string id;
  std::string name;
  std::string description;
  int spec_version = 0;
  std::string agent_id;
  std::optional<json::Value> agent_config;  // as written in the suite (re-emitted verbatim)
  std::uint32_t seed_start = 0;
  int seed_count = 0;
  int max_moves = 0;
  bool time_decisions = false;
  std::vector<std::string> tags;

  [[nodiscard]] bool has_tag(std::string_view t) const;
};

// Reads a suite file; throws std::runtime_error.
[[nodiscard]] Suite load_suite(const std::string& path);

struct GameResult {
  std::uint32_t seed = 0;
  std::int64_t score = 0;
  std::int64_t max_tile = 0;
  int move_count = 0;
  bool over = false;
  std::string history_hash;
  double wall_ms = 0;
  std::int64_t nodes = 0;
};

struct Summary {
  int games = 0;
  double avg_score = 0;
  double median_score = 0;
  std::int64_t min_score = 0;
  std::int64_t max_score = 0;
  std::int64_t max_tile = 0;
  std::int64_t total_moves = 0;
  double wall_ms = 0;
  std::optional<double> cpu_ms;
  double games_per_sec = 0;
  double moves_per_sec = 0;
  double decisions_per_sec = 0;
  std::int64_t nodes = 0;
  double nodes_per_sec = 0;
  std::optional<std::int64_t> peak_memory_bytes;
  std::optional<double> avg_decision_us;
  std::optional<double> p50_decision_us;
  std::optional<double> p99_decision_us;
  std::vector<std::pair<std::int64_t, int>> tile_distribution;  // sorted by tile
  std::vector<std::pair<std::int64_t, double>> reach_rates;     // sorted by tile
};

struct Result {
  std::string suite_id;
  json::Value implementation;
  json::Value environment;
  std::string agent_id;
  std::optional<json::Value> agent_config;
  bool deterministic = true;
  std::string started_at;
  std::string finished_at;
  std::vector<GameResult> games;
  Summary summary;
  std::string checksum;

  [[nodiscard]] json::Value to_json() const;
};

struct PlayResult {
  Game game;
  std::int64_t nodes = 0;
  double wall_ms = 0;
};

// Runs an agent on seed until the game ends or max_moves (0 = unlimited).
// Throws std::runtime_error if the agent misbehaves.
[[nodiscard]] PlayResult play(ai::Agent& agent, std::uint32_t seed, int max_moves,
                              const std::function<void(std::int64_t)>& on_decision = {});

[[nodiscard]] Summary summarise(const std::vector<GameResult>& games, double wall_ms, std::optional<double> cpu_ms,
                                std::optional<std::int64_t> peak, const std::vector<double>* decisions);

// fnv1a32 over the concatenated historyHash strings.
[[nodiscard]] std::string checksum(const std::vector<GameResult>& games);

[[nodiscard]] json::Value implementation_info();
[[nodiscard]] json::Value environment_info();

// Executes a suite; progress lines go to progress (may be null). Throws std::runtime_error.
[[nodiscard]] Result run(const Suite& suite, std::ostream* progress);

}  // namespace g2048::bench
