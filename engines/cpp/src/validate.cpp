#include "g2048/validate.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <memory>
#include <sstream>
#include <stdexcept>

#include "g2048/ai.hpp"
#include "g2048/bench.hpp"
#include "g2048/engine.hpp"

namespace g2048::validate {

namespace {

// Concatenates arguments into a message (doubles use the JSON number format).
template <typename... Args>
std::string cat(const Args&... args) {
  std::ostringstream ss;
  auto put = [&ss](const auto& a) {
    using T = std::decay_t<decltype(a)>;
    if constexpr (std::is_same_v<T, double>) {
      ss << json::format_number(a);
    } else if constexpr (std::is_same_v<T, bool>) {
      ss << (a ? "true" : "false");
    } else if constexpr (std::is_same_v<T, std::uint8_t>) {
      ss << static_cast<int>(a);
    } else {
      ss << a;
    }
  };
  (put(args), ...);
  return ss.str();
}

std::string state_str(const RngState& s) { return cat('[', s[0], ' ', s[1], ' ', s[2], ' ', s[3], ']'); }

RngState state_of(const json::Value& v) {
  const auto& a = v.as_array();
  if (a.size() != 4) throw json::Error("rng state must have 4 words");
  return {a[0].as_u32(), a[1].as_u32(), a[2].as_u32(), a[3].as_u32()};
}

json::Value load(const std::string& dir, const std::string& name) {
  return json::parse_file((std::filesystem::path(dir) / name).string());
}

// ---------------------------------------------------------------- rng.json

void check_rng(Report& r, const std::string& dir) {
  const std::string F = "rng.json";
  const auto fx = load(dir, F);
  for (const auto& c : fx["cases"].as_array()) {
    const auto seed = c["seed"].as_u32();
    const std::string id = cat("seed=", seed);
    const auto st = mix32(seed);
    const auto want = state_of(c["state"]);
    r.check(F, id + " state", st == want, cat("state ", state_str(st), ", want ", state_str(want)));
    Rng g(st);
    bool ok = true;
    const auto& next = c["next"].as_array();
    for (std::size_t i = 0; i < next.size(); ++i) {
      const auto got = g.next();
      const auto w = next[i].as_u32();
      if (got != w) {
        r.fail(F, id + " next", cat("next[", i, "]=", got, ", want ", w));
        ok = false;
        break;
      }
    }
    if (ok) r.check(F, id + " next", true);
    for (const auto& [ns, seq] : c["below"].as_object()) {
      const std::uint64_t n = std::stoull(ns);
      Rng gb = Rng::from_seed(seed);
      bool good = true;
      const auto& vals = seq.as_array();
      for (std::size_t i = 0; i < vals.size(); ++i) {
        const auto got = gb.below(n);
        const auto w = vals[i].as_u32();
        if (got != w) {
          r.fail(F, id + " below(" + ns + ")", cat("below[", i, "]=", got, ", want ", w));
          good = false;
          break;
        }
      }
      if (good) r.check(F, id + " below(" + ns + ")", true);
    }
  }
}

// ---------------------------------------------------------------- moves.json

void check_moves(Report& r, const std::string& dir) {
  const std::string F = "moves.json";
  const auto fx = load(dir, F);
  for (const auto& c : fx["cases"].as_array()) {
    const auto& hex = c["board"].as_string();
    const auto b = Board::from_hex(hex);
    if (!b) {
      r.fail(F, hex, "invalid boardHex");
      continue;
    }
    for (const auto& res : c["results"].as_array()) {
      const auto& dir_s = res["dir"].as_string();
      const int d = parse_direction(dir_s).value_or(0);
      const auto m = b->move(d);
      const auto nh = m.board.hex();
      const auto& want_board = res["board"].as_string();
      const auto want_gained = res["gained"].as_int();
      const auto want_changed = res["changed"].as_bool();
      const bool can = b->can_move(d);
      r.check(F, hex + " " + dir_s,
              nh == want_board && m.gained == want_gained && m.changed == want_changed && can == want_changed,
              cat("got board=", nh, " gained=", m.gained, " changed=", m.changed, " canMove=", can, ", want ",
                  want_board, " ", want_gained, " ", want_changed));
    }
    const bool over = c["over"].as_bool();
    r.check(F, hex + " over", b->is_over() == over, cat("over=", b->is_over(), ", want ", over));
  }
}

// ---------------------------------------------------------------- spawn.json

void check_spawn(Report& r, const std::string& dir) {
  const std::string F = "spawn.json";
  const auto fx = load(dir, F);
  const auto& cases = fx["cases"].as_array();
  for (std::size_t i = 0; i < cases.size(); ++i) {
    const auto& c = cases[i];
    Board b = Board::must(c["board"].as_string());
    Rng g(state_of(c["rngState"]));
    const auto sp = b.spawn(g);
    const auto& want_spawn = c["spawn"];
    bool good = b.hex() == c["result"].as_string() && g.state() == state_of(c["rngStateAfter"]) &&
                sp.has_value() == !want_spawn.is_null();
    if (good && sp) {
      good = sp->index == want_spawn["index"].as_int() && sp->exponent == want_spawn["exponent"].as_int();
    }
    r.check(F, cat('#', i, ' ', c["board"].as_string()), good,
            cat("got ", b.hex(), " idx=", sp ? sp->index : 0, " exp=", sp ? int{sp->exponent} : 0, " ok=",
                sp.has_value(), " state=", state_str(g.state())));
  }
}

// ---------------------------------------------------------------- hash.json

void check_hash(Report& r, const std::string& dir) {
  const std::string F = "hash.json";
  const auto fx = load(dir, F);
  for (const auto& c : fx["cases"].as_array()) {
    const auto& hex = c["board"].as_string();
    const Board b = Board::must(hex);
    const auto bh = hash_hex(board_hash(b));
    const auto prev = static_cast<std::uint32_t>(std::stoul(c["prev"].as_string(), nullptr, 16));
    const auto hs = hash_hex(history_step(prev, b, static_cast<int>(c["dir"].as_int())));
    const auto& want_bh = c["boardHash"].as_string();
    const auto& want_hs = c["historyStep"].as_string();
    r.check(F, hex, bh == want_bh && hs == want_hs,
            cat("boardHash=", bh, " historyStep=", hs, ", want ", want_bh, " ", want_hs));
  }
}

// ---------------------------------------------------------------- shared

bool same_final(const Snapshot& s, const json::Value& f) {
  return s.board == f["board"].as_string() && s.score == f["score"].as_int() && s.move_count == f["moveCount"].as_int() &&
         s.max_tile == f["maxTile"].as_int() && s.over == f["over"].as_bool() &&
         s.history_hash == f["historyHash"].as_string();
}

std::string snap_str(const Snapshot& s) {
  return cat("{board:", s.board, " score:", s.score, " moveCount:", s.move_count, " maxTile:", s.max_tile,
             " over:", s.over, " historyHash:", s.history_hash, "}");
}

// ---------------------------------------------------------------- games.json

void check_games(Report& r, const std::string& dir) {
  const std::string F = "games.json";
  const auto fx = load(dir, F);
  for (const auto& c : fx["newGames"].as_array()) {
    const auto seed = c["seed"].as_u32();
    const Game g(seed);
    r.check(F, cat("newGame seed=", seed),
            g.board.hex() == c["board"].as_string() && g.rng.state() == state_of(c["rngState"]) &&
                g.history_hash() == c["historyHash"].as_string(),
            cat("board=", g.board.hex(), " rng=", state_str(g.rng.state()), " hash=", g.history_hash()));
  }
  for (const auto& c : fx["games"].as_array()) {
    const auto seed = c["seed"].as_u32();
    const auto& agent_name = c["agent"].as_string();
    const auto& moves = c["moves"].as_string();
    const auto& fin = c["final"];
    const std::string id = cat("game seed=", seed, " agent=", agent_name);
    auto sim = simulate(seed, moves);
    if (sim.error) {
      r.fail(F, id + " replay", sim.error->message);
    } else {
      const auto s = sim.game->snapshot();
      r.check(F, id + " replay", same_final(s, fin), cat("final ", snap_str(s), ", want ", fin.dump()));
    }
    std::unique_ptr<ai::Agent> agent;
    if (agent_name == "random") {
      agent = std::make_unique<ai::RandomAgent>();
    } else if (agent_name == "expectimax-d2") {
      const json::Object cfg{{"depth", 2}};
      agent = ai::make_agent("expectimax", &cfg);
    } else {
      continue;
    }
    // Random games run to completion; expectimax-d2 games were generated with
    // maxMoves=1500, so cap at the recorded length when not over.
    const int limit = fin["over"].as_bool() ? 0 : static_cast<int>(moves.size());
    try {
      const auto pr = bench::play(*agent, seed, limit);
      r.check(F, id + " agent", pr.game.moves() == moves && same_final(pr.game.snapshot(), fin),
              cat("agent replay diverged (moves ", pr.game.moves().size(), " vs ", moves.size(), ")"));
    } catch (const std::exception& e) {
      r.fail(F, id + " agent", e.what());
    }
  }
}

// ---------------------------------------------------------------- replays.json

std::string err_str(const std::optional<ReplayError>& e) { return e ? e->message : "<nil>"; }

void check_replays(Report& r, const std::string& dir) {
  const std::string F = "replays.json";
  const auto fx = load(dir, F);
  for (const auto& c : fx["cases"].as_array()) {
    const auto& name = c["name"].as_string();
    const auto seed = c["seed"].as_u32();
    const auto& moves = c["moves"].as_string();
    const auto& expect = c["expect"];
    const auto res = verify_replay(1, seed, moves);
    if (expect["ok"].as_bool()) {
      const auto& f = expect["final"];
      const bool ok = res.ok() && same_final(res.snapshot, f);
      r.check(F, name, ok, cat("err=", err_str(res.error), " final=", snap_str(res.snapshot)));
      if (ok) {
        // A correct claim verifies, a wrong claim and a wrong spec version are rejected.
        FinalClaim claim{f["board"].as_string(), f["score"].as_int(), static_cast<int>(f["moveCount"].as_int()),
                         f["historyHash"].as_string()};
        const auto good = verify_replay(1, seed, moves, &claim);
        r.check(F, name + " claim", good.ok(), "valid claim rejected: " + err_str(good.error));
        FinalClaim bad;
        bad.score = f["score"].as_int() + 4;
        const auto rb = verify_replay(1, seed, moves, &bad);
        r.check(F, name + " bad-claim", rb.error && rb.error->code == kErrFinalMismatch,
                "want FINAL_MISMATCH, got " + err_str(rb.error));
        const auto rv = verify_replay(2, seed, moves);
        r.check(F, name + " spec-version", rv.error && rv.error->code == kErrSpecVersion,
                "want SPEC_VERSION, got " + err_str(rv.error));
      }
      continue;
    }
    const auto& want_code = expect["error"].as_string();
    bool ok = res.error && res.error->code == want_code;
    const auto* mi = expect.get("moveIndex");
    if (ok && mi && !mi->is_null()) ok = res.error->move_index == mi->as_int();
    r.check(F, name, ok,
            cat("got ", err_str(res.error), ", want ", want_code, " at ", mi && !mi->is_null() ? mi->dump() : "<nil>"));
  }
}

// ---------------------------------------------------------------- codes.json

void check_codes(Report& r, const std::string& dir) {
  const std::string F = "codes.json";
  const auto fx = load(dir, F);
  r.check(F, "alphabet", fx["alphabet"].as_string() == kReplayAlphabet, "alphabet mismatch");
  for (const auto& c : fx["cases"].as_array()) {
    const auto& input = c["input"].as_string();
    const auto n = normalize_replay_code(input);
    const auto& want_n = c["normalized"];
    const auto* want_f = c.get("formatted");
    bool good = false;
    if (want_n.is_null()) {
      good = !n;
    } else {
      good = n && *n == want_n.as_string() && want_f && want_f->is_string() && format_replay_code(*n) == want_f->as_string();
    }
    r.check(F, input, good, cat("normalized=\"", n.value_or(""), "\" ok=", n.has_value()));
  }
}

// ---------------------------------------------------------------- ai.json

ai::Weights weights_of(const json::Value& v) {
  return ai::Weights{v["lost"].as_int(),   v["empty"].as_int(),  v["merges"].as_int(), v["mono"].as_int(),
                     v["sum"].as_int(),    v["smooth"].as_int(), v["stable"].as_int(), v["corner"].as_int()};
}

ai::LineFeatures features_of(const json::Value& v) {
  return ai::LineFeatures{v["empty"].as_int(), v["merges"].as_int(), v["mono"].as_int(),
                          v["sum"].as_int(),   v["smooth"].as_int(), v["stable"].as_int()};
}

bool rel_close(double a, double b) {
  if (a == b) return true;
  return std::fabs(a - b) <= 1e-9 * std::max(std::fabs(a), std::fabs(b));
}

void check_ai(Report& r, const std::string& dir) {
  const std::string F = "ai.json";
  const auto fx = load(dir, F);
  const auto wc = weights_of(fx["weights"]["canonical"]);
  const auto wa = weights_of(fx["weights"]["allWeights"]);
  r.check(F, "canonical weights", wc == ai::kHeuristicV1, "canonical weights " + fx["weights"]["canonical"].dump());
  const auto& tc = ai::line_table(wc);
  const auto& ta = ai::line_table(wa);
  for (const auto& l : fx["lines"].as_array()) {
    const auto line = static_cast<std::uint16_t>(l["line"].as_int());
    const auto f = ai::features(line);
    const auto want = features_of(l["features"]);
    const double wcv = l["canonical"].as_double();
    const double wav = l["allWeights"].as_double();
    r.check(F, cat("line ", line), f == want && tc[line] == wcv && ta[line] == wav,
            cat("features ", json::Value(f.to_json()).dump(), " canonical=", tc[line], " allWeights=", ta[line],
                ", want ", l["features"].dump(), " ", wcv, " ", wav));
  }
  for (const auto& e : fx["evaluations"].as_array()) {
    const auto& hex = e["board"].as_string();
    const auto bb = ai::from_board(Board::must(hex));
    const double vc = ai::evaluate(bb, tc, wc.corner);
    const double va = ai::evaluate(bb, ta, wa.corner);
    const double wcv = e["canonical"].as_double();
    const double wav = e["allWeights"].as_double();
    r.check(F, "eval " + hex, vc == wcv && va == wav,
            cat("canonical=", vc, " allWeights=", va, ", want ", wcv, " ", wav));
  }
  for (const auto& m : fx["bitboardMoves"].as_array()) {
    const auto& hex = m["board"].as_string();
    const auto bb = ai::from_board(Board::must(hex));
    const auto& results = m["results"].as_array();
    for (std::size_t d = 0; d < results.size(); ++d) {
      const auto nb = ai::move(bb, static_cast<int>(d));
      const bool ch = nb != bb;
      const auto out = ai::to_board(nb).hex();
      const auto& want_b = results[d]["board"].as_string();
      const bool want_ch = results[d]["changed"].as_bool();
      r.check(F, cat("bbmove ", hex, ' ', kDirectionLetters[d]), out == want_b && ch == want_ch,
              cat("got ", out, " ", ch, ", want ", want_b, " ", want_ch));
    }
  }
  // One searcher per distinct config; its table persists across that config's searches.
  std::map<std::string, std::unique_ptr<ai::Search>> searchers;
  for (const auto& s : fx["searches"].as_array()) {
    const auto& hex = s["board"].as_string();
    const std::string id = cat("search ", s["profile"].as_string(), " ", hex);
    const auto key = s["config"].dump();
    auto& srch = searchers[key];
    if (!srch) {
      try {
        auto c = ai::Config::parse(&s["config"].as_object());
        c.tt_bits = 18;
        srch = std::make_unique<ai::Search>(c);
      } catch (const std::invalid_argument& e) {
        searchers.erase(key);
        r.fail(F, id, cat("config: ", e.what()));
        continue;
      }
    }
    const auto res = srch->run(ai::from_board(Board::must(hex)));
    const std::string move = res.move >= 0 ? std::string(1, kDirectionLetters[static_cast<std::size_t>(res.move)]) : "null";
    const auto& wm = s["move"];
    const std::string want = wm.is_null() ? "null" : wm.as_string();
    const auto& values = s["values"].as_array();
    const auto want_depth = s["depth"].as_int();
    bool ok = move == want && res.depth == want_depth && values.size() == 4;
    std::string msg = cat("move=", move, " depth=", res.depth, ", want ", want, " ", want_depth);
    for (std::size_t d = 0; ok && d < 4; ++d) {
      const auto& got = res.values[d];
      const auto& exp = values[d];
      if (got.has_value() == exp.is_null()) {
        ok = false;
        msg = cat("values[", d, "] null mismatch");
      } else if (got && !rel_close(*got, exp.as_double())) {
        ok = false;
        msg = cat("values[", d, "]=", *got, ", want ", exp.as_double());
      }
    }
    r.check(F, id, ok, msg);
  }
}

// ---------------------------------------------------------------- benchmarks.json

void check_benchmarks(Report& r, const std::string& dir) {
  const std::string F = "benchmarks.json";
  const auto fx = load(dir, F);
  std::vector<std::string> ids;
  for (const auto& [id, _] : fx["suites"].as_object()) ids.push_back(id);
  std::sort(ids.begin(), ids.end());
  for (const auto& id : ids) {
    const auto& want = fx["suites"][id];
    try {
      const auto suite =
          bench::load_suite((std::filesystem::path(dir) / ".." / "benchmarks" / (id + ".json")).string());
      if (suite.has_tag("heavy")) continue;
      const auto res = bench::run(suite, nullptr);
      std::int64_t total = 0;
      for (const auto& g : res.games) total += g.score;
      const auto& s = res.summary;
      r.check(F, id,
              res.checksum == want["checksum"].as_string() && s.games == want["games"].as_int() &&
                  s.total_moves == want["totalMoves"].as_int() && total == want["totalScore"].as_int() &&
                  s.max_score == want["maxScore"].as_int(),
              cat("checksum=", res.checksum, " games=", s.games, " totalMoves=", s.total_moves, " totalScore=", total,
                  " maxScore=", s.max_score, ", want ", want.dump()));
    } catch (const std::exception& e) {
      r.fail(F, id, e.what());
    }
  }
}

}  // namespace

bool Report::check(const std::string& fixture, const std::string& name, bool ok, const std::string& message) {
  auto& pf = per_fixture[fixture];
  if (ok) {
    ++passed;
    ++pf[0];
  } else {
    ++failed;
    ++pf[1];
    failures.push_back(Failure{fixture, name, message});
  }
  return ok;
}

json::Value Report::to_json() const {
  json::Array fs;
  for (const auto& f : failures) {
    fs.emplace_back(json::Object{{"fixture", f.fixture}, {"case", f.case_name}, {"message", f.message}});
  }
  return json::Object{{"language", language},
                      {"engineVersion", kEngineVersion},
                      {"passed", passed},
                      {"failed", failed},
                      {"failures", std::move(fs)}};
}

void run(Report& r, const std::string& dir, const std::string& name) {
  try {
    if (name == "rng.json") check_rng(r, dir);
    else if (name == "moves.json") check_moves(r, dir);
    else if (name == "spawn.json") check_spawn(r, dir);
    else if (name == "hash.json") check_hash(r, dir);
    else if (name == "games.json") check_games(r, dir);
    else if (name == "replays.json") check_replays(r, dir);
    else if (name == "codes.json") check_codes(r, dir);
    else if (name == "ai.json") check_ai(r, dir);
    else if (name == "benchmarks.json") check_benchmarks(r, dir);
    else r.fail(name, "load", "unknown fixture");
  } catch (const std::exception& e) {
    r.fail(name, "load", e.what());
  }
}

Report all(const std::string& dir, const Options& opts) {
  Report r;
  for (const auto& f : kFixtures) {
    if (f == "benchmarks.json" && opts.skip_benchmarks) continue;
    run(r, dir, f);
  }
  return r;
}

}  // namespace g2048::validate
