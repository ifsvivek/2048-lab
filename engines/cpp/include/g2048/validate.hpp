// Checks this port against the cross-language fixtures in spec/fixtures.
#pragma once

#include <array>
#include <map>
#include <string>
#include <string_view>
#include <vector>

#include "g2048/json.hpp"

namespace g2048::validate {

struct Failure {
  std::string fixture;
  std::string case_name;
  std::string message;
};

struct Report {
  std::string language = "cpp";
  int passed = 0;
  int failed = 0;
  std::vector<Failure> failures;
  // passed/failed case counts by fixture file.
  std::map<std::string, std::array<int, 2>> per_fixture;

  // Records one case; returns ok.
  bool check(const std::string& fixture, const std::string& name, bool ok, const std::string& message = {});
  void fail(const std::string& fixture, const std::string& name, const std::string& message) {
    check(fixture, name, false, message);
  }
  [[nodiscard]] json::Value to_json() const;
};

// Fixture files in check order.
inline const std::vector<std::string> kFixtures = {"rng.json",     "moves.json", "spawn.json",
                                                   "hash.json",    "games.json", "replays.json",
                                                   "codes.json",   "ai.json",    "benchmarks.json"};

struct Options {
  // Skips running the benchmark suites (benchmarks.json).
  bool skip_benchmarks = false;
};

// Runs every fixture check against dir.
[[nodiscard]] Report all(const std::string& dir, const Options& opts);

// Checks a single fixture file, adding to r.
void run(Report& r, const std::string& dir, const std::string& name);

}  // namespace g2048::validate
