#include "g2048/bench.hpp"

#include <sys/resource.h>
#include <sys/utsname.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <fstream>
#include <map>
#include <ostream>
#include <stdexcept>
#include <thread>

namespace g2048::bench {

namespace {

using Clock = std::chrono::steady_clock;

double ms_since(Clock::time_point t) {
  return static_cast<double>(std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - t).count()) / 1e6;
}

std::optional<rusage> self_rusage() {
  rusage ru{};
  if (getrusage(RUSAGE_SELF, &ru) != 0) return std::nullopt;
  return ru;
}

std::optional<double> cpu_ms() {
  auto ru = self_rusage();
  if (!ru) return std::nullopt;
  auto ms = [](const timeval& tv) { return static_cast<double>(tv.tv_sec) * 1e3 + static_cast<double>(tv.tv_usec) / 1e3; };
  return ms(ru->ru_utime) + ms(ru->ru_stime);
}

std::optional<std::int64_t> peak_memory() {
  auto ru = self_rusage();
  if (!ru) return std::nullopt;
#ifdef __APPLE__
  return static_cast<std::int64_t>(ru->ru_maxrss);  // bytes
#else
  return static_cast<std::int64_t>(ru->ru_maxrss) * 1024;  // KiB
#endif
}

std::string iso_now() {
  const auto now = std::chrono::system_clock::now();
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
  const std::time_t secs = static_cast<std::time_t>(ms / 1000);
  std::tm tm{};
  gmtime_r(&secs, &tm);
  char buf[96];
  std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms % 1000));
  return buf;
}

double percentile(const std::vector<double>& sorted, double p) {
  if (sorted.empty()) return 0;
  const auto idx = static_cast<std::size_t>(std::floor(p * static_cast<double>(sorted.size())));
  return sorted[std::min(sorted.size() - 1, idx)];
}

std::string trim(const std::string& s) {
  const auto b = s.find_first_not_of(" \t\r\n");
  if (b == std::string::npos) return "";
  const auto e = s.find_last_not_of(" \t\r\n");
  return s.substr(b, e - b + 1);
}

constexpr std::int64_t kReachTiles[] = {2048, 4096, 8192, 16384, 32768, 65536};

}  // namespace

bool Suite::has_tag(std::string_view t) const { return std::find(tags.begin(), tags.end(), t) != tags.end(); }

Suite load_suite(const std::string& path) {
  const json::Value v = json::parse_file(path);
  try {
    Suite s;
    s.id = v["id"].as_string();
    if (const auto* n = v.get("name")) s.name = n->as_string();
    if (const auto* d = v.get("description")) s.description = d->as_string();
    s.spec_version = static_cast<int>(v["specVersion"].as_int());
    const auto& agent = v["agent"];
    s.agent_id = agent["id"].as_string();
    if (const auto* c = agent.get("config"); c && !c->is_null()) s.agent_config = *c;
    s.seed_start = v["seeds"]["start"].as_u32();
    s.seed_count = static_cast<int>(v["seeds"]["count"].as_int());
    if (const auto* m = v.get("maxMoves")) s.max_moves = static_cast<int>(m->as_int());
    if (const auto* t = v.get("timeDecisions")) s.time_decisions = t->as_bool();
    if (const auto* tags = v.get("tags")) {
      for (const auto& t : tags->as_array()) s.tags.push_back(t.as_string());
    }
    return s;
  } catch (const json::Error& e) {
    throw std::runtime_error(path + ": " + e.what());
  }
}

PlayResult play(ai::Agent& agent, std::uint32_t seed, int max_moves, const std::function<void(std::int64_t)>& on_decision) {
  const auto t0 = Clock::now();
  Game g(seed);
  agent.reset(g.seed);
  std::int64_t nodes = 0;
  while ((max_moves <= 0 || g.move_count < max_moves) && !g.over()) {
    const auto d = agent.decide(g.board);
    if (d.move < 0) {
      throw std::runtime_error("agent " + std::string(agent.id()) + " returned no move at " + std::to_string(g.move_count));
    }
    if (!g.apply(d.move)) {
      throw std::runtime_error("agent " + std::string(agent.id()) + " returned invalid move " + std::to_string(d.move) +
                               " at " + std::to_string(g.move_count));
    }
    if (d.metrics.nodes) nodes += *d.metrics.nodes;
    if (on_decision) on_decision(d.metrics.time_us);
  }
  return PlayResult{std::move(g), nodes, ms_since(t0)};
}

Summary summarise(const std::vector<GameResult>& games, double wall_ms, std::optional<double> cpu,
                  std::optional<std::int64_t> peak, const std::vector<double>* decisions) {
  Summary s;
  s.games = static_cast<int>(games.size());
  s.wall_ms = wall_ms;
  s.cpu_ms = cpu;
  s.peak_memory_bytes = peak;
  std::vector<std::int64_t> scores;
  scores.reserve(games.size());
  std::int64_t total = 0;
  std::map<std::int64_t, int> dist;
  for (const auto& g : games) {
    scores.push_back(g.score);
    total += g.score;
    s.total_moves += g.move_count;
    s.nodes += g.nodes;
    s.max_tile = std::max(s.max_tile, g.max_tile);
    ++dist[g.max_tile];
  }
  s.tile_distribution.assign(dist.begin(), dist.end());
  std::sort(scores.begin(), scores.end());
  if (const auto n = scores.size(); n > 0) {
    s.avg_score = static_cast<double>(total) / static_cast<double>(n);
    s.median_score = static_cast<double>(scores[n / 2]);
    s.min_score = scores.front();
    s.max_score = scores.back();
  }
  for (auto t : kReachTiles) {
    double r = 0;
    if (!games.empty()) {
      const auto c = std::count_if(games.begin(), games.end(), [t](const GameResult& g) { return g.max_tile >= t; });
      r = static_cast<double>(c) / static_cast<double>(games.size());
    }
    s.reach_rates.emplace_back(t, r);
  }
  const double secs = wall_ms / 1000;
  if (secs > 0) {
    s.games_per_sec = static_cast<double>(games.size()) / secs;
    s.moves_per_sec = static_cast<double>(s.total_moves) / secs;
    s.decisions_per_sec = s.moves_per_sec;
    s.nodes_per_sec = static_cast<double>(s.nodes) / secs;
  }
  if (decisions && !decisions->empty()) {
    std::vector<double> sorted = *decisions;
    std::sort(sorted.begin(), sorted.end());
    double sum = 0;
    for (double x : sorted) sum += x;
    s.avg_decision_us = sum / static_cast<double>(sorted.size());
    s.p50_decision_us = percentile(sorted, 0.5);
    s.p99_decision_us = percentile(sorted, 0.99);
  }
  return s;
}

std::string checksum(const std::vector<GameResult>& games) {
  std::string b;
  b.reserve(games.size() * 8);
  for (const auto& g : games) b += g.history_hash;
  return hash_hex(fnv1a32(b));
}

json::Value implementation_info() {
#if defined(__clang__)
  const std::string runtime_version = "clang++ " __clang_version__;
#elif defined(__GNUC__)
  const std::string runtime_version = "g++ " __VERSION__;
#else
  const std::string runtime_version = "unknown";
#endif
#if defined(__APPLE__)
  const char* platform = "darwin";
#elif defined(__linux__)
  const char* platform = "linux";
#elif defined(_WIN32)
  const char* platform = "win32";
#else
  const char* platform = "unknown";
#endif
  return json::Object{{"language", "cpp"},
                      {"runtime", "native"},
                      {"runtimeVersion", trim(runtime_version)},
                      {"engineVersion", kEngineVersion},
                      {"platform", platform}};
}

json::Value environment_info() {
  // Keys sorted alphabetically, like the Go port's map serialisation.
  std::map<std::string, json::Value> env;
  utsname u{};
  if (uname(&u) == 0) {
    std::string os = u.sysname;
    std::transform(os.begin(), os.end(), os.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    env["os"] = os;
    env["arch"] = std::string(u.machine);
  }
  env["cpus"] = static_cast<std::int64_t>(std::thread::hardware_concurrency());
  if (std::ifstream f("/proc/cpuinfo"); f) {
    for (std::string line; std::getline(f, line);) {
      const auto colon = line.find(':');
      if (colon != std::string::npos && trim(line.substr(0, colon)) == "model name") {
        env["cpu"] = trim(line.substr(colon + 1));
        break;
      }
    }
  }
  if (std::ifstream f("/proc/meminfo"); f) {
    for (std::string line; std::getline(f, line);) {
      long long kb = 0;
      if (std::sscanf(line.c_str(), "MemTotal: %lld kB", &kb) == 1) {
        env["memoryBytes"] = static_cast<std::int64_t>(kb) * 1024;
        break;
      }
    }
  }
  json::Object o;
  for (auto& [k, v] : env) o.set(k, std::move(v));
  return o;
}

Result run(const Suite& suite, std::ostream* progress) {
  if (suite.spec_version != kSpecVersion) {
    throw std::runtime_error("suite " + suite.id + " targets spec v" + std::to_string(suite.spec_version));
  }
  const json::Object* cfg = nullptr;
  if (suite.agent_config) {
    if (!suite.agent_config->is_object()) throw std::runtime_error("agent config: must be an object");
    cfg = &suite.agent_config->as_object();
  }
  std::unique_ptr<ai::Agent> agent;
  try {
    agent = ai::make_agent(suite.agent_id, cfg);
  } catch (const std::invalid_argument& e) {
    throw std::runtime_error(e.what());
  }

  Result res;
  res.started_at = iso_now();
  const auto cpu0 = cpu_ms();
  const auto t0 = Clock::now();
  std::vector<double> decisions;
  std::function<void(std::int64_t)> on_decision;
  if (suite.time_decisions) {
    decisions.reserve(1024);
    on_decision = [&decisions](std::int64_t us) { decisions.push_back(static_cast<double>(us)); };
  }
  res.games.reserve(static_cast<std::size_t>(std::max(0, suite.seed_count)));
  for (int i = 0; i < suite.seed_count; ++i) {
    const std::uint32_t seed = suite.seed_start + static_cast<std::uint32_t>(i);
    const auto pr = play(*agent, seed, suite.max_moves, on_decision);
    const Game& g = pr.game;
    GameResult r{seed,    g.score,          std::int64_t{1} << g.board.max_exponent(), g.move_count, g.over(),
                 g.history_hash(), pr.wall_ms, pr.nodes};
    if (progress && (suite.seed_count <= 100 || (i + 1) % 100 == 0 || i + 1 == suite.seed_count)) {
      char buf[256];
      std::snprintf(buf, sizeof buf, "] game %d/%d seed=%u score=%lld maxTile=%lld moves=%d %.0fms\n", i + 1,
                    suite.seed_count, seed, static_cast<long long>(r.score), static_cast<long long>(r.max_tile),
                    r.move_count, r.wall_ms);
      *progress << '[' << suite.id << buf << std::flush;
    }
    res.games.push_back(std::move(r));
  }
  const double wall_ms = ms_since(t0);
  std::optional<double> cpu;
  if (const auto c1 = cpu_ms(); c1 && cpu0) cpu = *c1 - *cpu0;

  res.suite_id = suite.id;
  res.implementation = implementation_info();
  res.environment = environment_info();
  res.agent_id = suite.agent_id;
  res.agent_config = suite.agent_config;
  res.deterministic = agent->deterministic();
  res.finished_at = iso_now();
  res.summary = summarise(res.games, wall_ms, cpu, peak_memory(), suite.time_decisions ? &decisions : nullptr);
  res.checksum = checksum(res.games);
  return res;
}

json::Value Result::to_json() const {
  auto opt = [](const auto& o) { return o ? json::Value(*o) : json::Value(nullptr); };

  json::Object agent{{"id", agent_id}};
  if (agent_config) agent.set("config", *agent_config);

  json::Array gs;
  gs.reserve(games.size());
  for (const auto& g : games) {
    gs.emplace_back(json::Object{{"seed", g.seed},
                                 {"score", g.score},
                                 {"maxTile", g.max_tile},
                                 {"moveCount", g.move_count},
                                 {"over", g.over},
                                 {"historyHash", g.history_hash},
                                 {"wallMs", g.wall_ms},
                                 {"nodes", g.nodes}});
  }

  json::Object dist;
  for (const auto& [tile, n] : summary.tile_distribution) dist.set(std::to_string(tile), n);
  json::Object reach;
  for (const auto& [tile, r] : summary.reach_rates) reach.set(std::to_string(tile), r);

  const auto& s = summary;
  json::Object sum{{"games", s.games},
                   {"avgScore", s.avg_score},
                   {"medianScore", s.median_score},
                   {"minScore", s.min_score},
                   {"maxScore", s.max_score},
                   {"maxTile", s.max_tile},
                   {"totalMoves", s.total_moves},
                   {"wallMs", s.wall_ms},
                   {"cpuMs", opt(s.cpu_ms)},
                   {"gamesPerSec", s.games_per_sec},
                   {"movesPerSec", s.moves_per_sec},
                   {"decisionsPerSec", s.decisions_per_sec},
                   {"nodes", s.nodes},
                   {"nodesPerSec", s.nodes_per_sec},
                   {"peakMemoryBytes", opt(s.peak_memory_bytes)},
                   {"avgDecisionUs", opt(s.avg_decision_us)},
                   {"p50DecisionUs", opt(s.p50_decision_us)},
                   {"p99DecisionUs", opt(s.p99_decision_us)},
                   {"tileDistribution", std::move(dist)},
                   {"reachRates", std::move(reach)}};

  return json::Object{{"schemaVersion", 1},
                      {"suiteId", suite_id},
                      {"specVersion", kSpecVersion},
                      {"implementation", implementation},
                      {"environment", environment},
                      {"agent", std::move(agent)},
                      {"deterministic", deterministic},
                      {"startedAt", started_at},
                      {"finishedAt", finished_at},
                      {"games", std::move(gs)},
                      {"summary", std::move(sum)},
                      {"checksum", checksum}};
}

}  // namespace g2048::bench
