// g2048 — C++ port CLI: validate, bench, play.
#include <cstdio>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "g2048/ai.hpp"
#include "g2048/bench.hpp"
#include "g2048/engine.hpp"
#include "g2048/json.hpp"
#include "g2048/validate.hpp"

namespace {

using namespace g2048;

constexpr std::string_view kUsage = R"(usage: g2048 <command> [flags]

commands:
  validate [--fixtures DIR] [--json] [--skip-bench]   run every spec fixture check
  bench --suite FILE [--out FILE]                      run a benchmark suite, emit BenchmarkResult JSON
  play --seed N [--agent expectimax|random|greedy] [--depth auto|N] [--max-moves N]
)";

struct UsageError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Go-style flag parsing: -name / --name, "=value" or the next argument; bool
// flags take no value (or =true/=false).
class Flags {
 public:
  Flags(std::set<std::string> bools, std::set<std::string> values) : bools_(std::move(bools)), values_(std::move(values)) {}

  void parse(const std::vector<std::string>& args) {
    for (std::size_t i = 0; i < args.size(); ++i) {
      std::string_view a = args[i];
      if (a.size() < 2 || a[0] != '-') throw UsageError("unexpected argument '" + std::string(a) + "'");
      a.remove_prefix(a[1] == '-' ? 2 : 1);
      std::string name(a);
      std::optional<std::string> value;
      if (auto eq = name.find('='); eq != std::string::npos) {
        value = name.substr(eq + 1);
        name.resize(eq);
      }
      if (name == "h" || name == "help") throw UsageError("");
      if (bools_.count(name)) {
        set_[name] = value.value_or("true");
      } else if (values_.count(name)) {
        if (!value) {
          if (i + 1 >= args.size()) throw UsageError("flag needs an argument: -" + name);
          value = args[++i];
        }
        set_[name] = *value;
      } else {
        throw UsageError("flag provided but not defined: -" + name);
      }
    }
  }

  [[nodiscard]] std::optional<std::string> get(const std::string& name) const {
    if (auto it = set_.find(name); it != set_.end()) return it->second;
    return std::nullopt;
  }
  [[nodiscard]] std::string get_or(const std::string& name, std::string def) const { return get(name).value_or(std::move(def)); }
  [[nodiscard]] bool flag(const std::string& name) const {
    auto v = get(name);
    return v && (*v == "true" || *v == "1" || *v == "t" || *v == "TRUE" || *v == "True");
  }

 private:
  std::set<std::string> bools_, values_;
  std::map<std::string, std::string> set_;
};

std::string default_fixtures() {
  for (const char* c : {"../../spec/fixtures", "spec/fixtures", "../spec/fixtures", "../../../spec/fixtures"}) {
    std::error_code ec;
    if (std::filesystem::is_directory(c, ec)) return c;
  }
  return "../../spec/fixtures";
}

int cmd_validate(const std::vector<std::string>& args) {
  Flags fs({"json", "skip-bench"}, {"fixtures"});
  fs.parse(args);
  const std::string dir = fs.get_or("fixtures", default_fixtures());
  const auto r = validate::all(dir, validate::Options{fs.flag("skip-bench")});
  if (fs.flag("json")) {
    std::cout << r.to_json().dump() << '\n';
  } else {
    std::cout << "cpp engine " << kEngineVersion << " — fixtures: " << dir << '\n';
    for (const auto& f : validate::kFixtures) {
      if (auto it = r.per_fixture.find(f); it != r.per_fixture.end()) {
        const auto& [ok, bad] = it->second;
        std::printf("  %-16s %4d passed %4d failed  %s\n", f.c_str(), ok, bad, bad > 0 ? "FAIL" : "ok");
        std::fflush(stdout);
      }
    }
    for (const auto& f : r.failures) {
      std::cout << "  FAIL " << f.fixture << " [" << f.case_name << "]: " << f.message << '\n';
    }
    std::cout << r.passed << " passed, " << r.failed << " failed\n";
  }
  return r.failed > 0 ? 1 : 0;
}

int cmd_bench(const std::vector<std::string>& args) {
  Flags fs({}, {"suite", "out"});
  fs.parse(args);
  const auto suite_path = fs.get("suite");
  if (!suite_path || suite_path->empty()) throw std::runtime_error("--suite is required");
  const auto suite = bench::load_suite(*suite_path);
  const auto res = bench::run(suite, &std::cerr);
  const std::string data = res.to_json().dump(2) + "\n";
  const auto& s = res.summary;
  std::fprintf(stderr, "[%s] checksum=%s games=%d moves=%lld wall=%.0fms moves/s=%.0f games/s=%.2f nodes/s=%.0f\n",
               suite.id.c_str(), res.checksum.c_str(), s.games, static_cast<long long>(s.total_moves), s.wall_ms,
               s.moves_per_sec, s.games_per_sec, s.nodes_per_sec);
  const auto out = fs.get_or("out", "");
  if (out.empty()) {
    std::cout << data << std::flush;
    return 0;
  }
  if (auto parent = std::filesystem::path(out).parent_path(); !parent.empty()) {
    std::error_code ec;
    std::filesystem::create_directories(parent, ec);
  }
  std::ofstream f(out, std::ios::binary | std::ios::trunc);
  if (!f || !(f << data)) throw std::runtime_error("cannot write " + out);
  return 0;
}

int cmd_play(const std::vector<std::string>& args) {
  Flags fs({}, {"seed", "agent", "depth", "max-moves"});
  fs.parse(args);
  std::uint32_t seed = random_seed();
  if (auto s = fs.get("seed"); s && !s->empty()) {
    try {
      std::size_t pos = 0;
      const auto n = std::stoull(*s, &pos, 10);
      if (pos != s->size() || n > 0xFFFFFFFFull || (*s)[0] == '-') throw std::out_of_range("");
      seed = static_cast<std::uint32_t>(n);
    } catch (const std::exception&) {
      throw std::runtime_error("--seed must be a uint32");
    }
  }
  const std::string agent_id = fs.get_or("agent", "expectimax");
  const std::string depth = fs.get_or("depth", "auto");
  int max_moves = 0;
  if (auto m = fs.get("max-moves")) {
    try {
      max_moves = std::stoi(*m);
    } catch (const std::exception&) {
      throw std::runtime_error("--max-moves must be an integer");
    }
  }
  json::Object cfg;
  if (!depth.empty() && depth != "auto") {
    int n = 0;
    try {
      std::size_t pos = 0;
      n = std::stoi(depth, &pos);
      if (pos != depth.size()) n = 0;
    } catch (const std::exception&) {
      n = 0;
    }
    if (n < 1) throw std::runtime_error("--depth must be 'auto' or a positive integer");
    cfg.set("depth", n);
  }
  std::unique_ptr<ai::Agent> agent;
  try {
    agent = ai::make_agent(agent_id, &cfg);
  } catch (const std::invalid_argument& e) {
    throw std::runtime_error(e.what());
  }
  const auto pr = bench::play(*agent, seed, max_moves);
  const auto snap = pr.game.snapshot();
  const json::Value out = json::Object{{"seed", snap.seed},
                                       {"board", snap.board},
                                       {"score", snap.score},
                                       {"moveCount", snap.move_count},
                                       {"maxTile", snap.max_tile},
                                       {"over", snap.over},
                                       {"historyHash", snap.history_hash},
                                       {"specVersion", kSpecVersion},
                                       {"agent", agent_id},
                                       {"nodes", pr.nodes},
                                       {"wallMs", pr.wall_ms},
                                       {"moves", pr.game.moves()}};
  std::cout << out.dump(2) << '\n';
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << kUsage;
    return 2;
  }
  const std::string cmd = argv[1];
  const std::vector<std::string> args(argv + 2, argv + argc);
  try {
    if (cmd == "validate") return cmd_validate(args);
    if (cmd == "bench") return cmd_bench(args);
    if (cmd == "play") return cmd_play(args);
    if (cmd == "-h" || cmd == "--help" || cmd == "help") {
      std::cout << kUsage;
      return 0;
    }
    std::cerr << "unknown command \"" << cmd << "\"\n\n" << kUsage;
    return 2;
  } catch (const UsageError& e) {
    if (*e.what()) std::cerr << e.what() << "\n";
    std::cerr << kUsage;
    return 2;
  } catch (const std::exception& e) {
    std::cerr << "error: " << e.what() << '\n';
    return 1;
  }
}
