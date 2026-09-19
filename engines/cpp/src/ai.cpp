#include "g2048/ai.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>
#include <map>
#include <mutex>
#include <stdexcept>

namespace g2048::ai {

// ---------------------------------------------------------------- bitboard

namespace {

std::uint16_t reverse_line(std::uint16_t v) noexcept {
  return static_cast<std::uint16_t>((v & 0xf) << 12 | ((v >> 4) & 0xf) << 8 | ((v >> 8) & 0xf) << 4 | ((v >> 12) & 0xf));
}

struct MoveTables {
  // toward_low slides toward the low nibble ("left" for rows, "up" for columns).
  std::array<std::uint16_t, 65536> toward_low{};
  // toward_high slides toward the high nibble ("right" / "down").
  std::array<std::uint16_t, 65536> toward_high{};
  // spread_col places a line value as column 0 (nibble k -> row k).
  std::array<std::uint64_t, 65536> spread_col{};

  MoveTables() {
    for (std::uint32_t v = 0; v < 65536; ++v) {
      std::array<std::uint16_t, 4> r{};
      for (std::size_t k = 0; k < 4; ++k) r[k] = static_cast<std::uint16_t>((v >> (4 * k)) & 0xf);
      std::array<std::uint16_t, 4> tiles{};
      std::size_t n = 0;
      for (auto x : r) {
        if (x != 0) tiles[n++] = x;
      }
      std::array<std::uint16_t, 4> out{};
      std::size_t o = 0;
      for (std::size_t i = 0; i < n; ++i) {
        if (i + 1 < n && tiles[i] == tiles[i + 1]) {
          out[o] = std::min<std::uint16_t>(static_cast<std::uint16_t>(tiles[i] + 1), 15);
          ++i;
        } else {
          out[o] = tiles[i];
        }
        ++o;
      }
      toward_low[v] = static_cast<std::uint16_t>(out[0] | out[1] << 4 | out[2] << 8 | out[3] << 12);
      spread_col[v] = std::uint64_t{r[0]} | std::uint64_t{r[1]} << 16 | std::uint64_t{r[2]} << 32 | std::uint64_t{r[3]} << 48;
    }
    for (std::uint32_t v = 0; v < 65536; ++v) {
      toward_high[v] = reverse_line(toward_low[reverse_line(static_cast<std::uint16_t>(v))]);
    }
  }
};

const MoveTables kMoves;

}  // namespace

std::uint16_t column(Bitboard b, int c) noexcept {
  const Bitboard x = b >> (4 * c);
  return static_cast<std::uint16_t>((x & 0xf) | ((x >> 16) & 0xf) << 4 | ((x >> 32) & 0xf) << 8 | ((x >> 48) & 0xf) << 12);
}

Bitboard move(Bitboard b, int dir) noexcept {
  switch (dir) {
    case kLeft:
    case kRight: {
      const auto& t = dir == kLeft ? kMoves.toward_low : kMoves.toward_high;
      return Bitboard{t[static_cast<std::uint16_t>(b)]} | Bitboard{t[static_cast<std::uint16_t>(b >> 16)]} << 16 |
             Bitboard{t[static_cast<std::uint16_t>(b >> 32)]} << 32 | Bitboard{t[static_cast<std::uint16_t>(b >> 48)]} << 48;
    }
    default: {
      const auto& t = dir == kUp ? kMoves.toward_low : kMoves.toward_high;
      const auto& sc = kMoves.spread_col;
      return sc[t[column(b, 0)]] | sc[t[column(b, 1)]] << 4 | sc[t[column(b, 2)]] << 8 | sc[t[column(b, 3)]] << 12;
    }
  }
}

Bitboard from_board(const Board& board) noexcept {
  Bitboard b = 0;
  for (int i = 0; i < 16; ++i) b |= Bitboard{std::min<std::uint8_t>(board[i], 15)} << (4 * i);
  return b;
}

Board to_board(Bitboard b) noexcept {
  Board out;
  for (int i = 0; i < 16; ++i) out[i] = static_cast<std::uint8_t>((b >> (4 * i)) & 0xf);
  return out;
}

int distinct_ranks(Bitboard b) noexcept {
  std::uint32_t mask = 0;
  for (int i = 0; i < 16; ++i) mask |= 1u << ((b >> (4 * i)) & 0xf);
  return std::popcount(mask & ~1u);
}

// ---------------------------------------------------------------- heuristic

json::Value Weights::to_json() const {
  return json::Object{{"lost", lost}, {"empty", empty}, {"merges", merges}, {"mono", mono},
                      {"sum", sum},   {"smooth", smooth}, {"stable", stable}, {"corner", corner}};
}

json::Object LineFeatures::to_json() const {
  return json::Object{{"empty", empty}, {"merges", merges}, {"mono", mono},
                      {"sum", sum},     {"smooth", smooth}, {"stable", stable}};
}

LineFeatures features(std::uint16_t v) noexcept {
  const std::array<std::int64_t, 4> r = {v & 0xf, (v >> 4) & 0xf, (v >> 8) & 0xf, (v >> 12) & 0xf};
  LineFeatures f;
  std::int64_t prev = 0, counter = 0;
  for (auto rank : r) {
    f.sum += rank * rank * rank;
    if (rank == 0) {
      ++f.empty;
      continue;
    }
    if (prev == rank) {
      ++counter;
    } else if (counter > 0) {
      f.merges += 1 + counter;
      counter = 0;
    }
    prev = rank;
  }
  if (counter > 0) f.merges += 1 + counter;
  std::int64_t mono_l = 0, mono_r = 0;
  for (std::size_t i = 1; i < 4; ++i) {
    const std::int64_t a = r[i - 1] * r[i - 1] * r[i - 1] * r[i - 1];
    const std::int64_t b = r[i] * r[i] * r[i] * r[i];
    if (r[i - 1] > r[i]) {
      mono_l += a - b;
    } else {
      mono_r += b - a;
    }
    if (r[i - 1] != 0 && r[i] != 0) f.smooth += std::abs(r[i - 1] - r[i]);
  }
  if (f.empty == 0 && (mono_l == 0 || mono_r == 0)) f.stable = 1;
  f.mono = std::min(mono_l, mono_r);
  return f;
}

std::int64_t line_score(const LineFeatures& f, const Weights& w) noexcept {
  return w.lost + w.empty * f.empty + w.merges * f.merges - w.mono * f.mono - w.sum * f.sum - w.smooth * f.smooth +
         w.stable * f.stable;
}

const LineTable& line_table(const Weights& w) {
  static std::mutex mu;
  static std::map<Weights, std::unique_ptr<LineTable>> cache;
  std::lock_guard lock(mu);
  auto& slot = cache[w];
  if (!slot) {
    slot = std::make_unique<LineTable>();
    for (std::uint32_t v = 0; v < 65536; ++v) {
      (*slot)[v] = static_cast<double>(line_score(features(static_cast<std::uint16_t>(v)), w));
    }
  }
  return *slot;
}

double corner_term(Bitboard b, std::int64_t corner_weight) noexcept {
  if (corner_weight == 0) return 0;
  Bitboard mx = 0;
  for (int i = 0; i < 16; ++i) mx = std::max(mx, (b >> (4 * i)) & 0xf);
  if ((b & 0xf) == mx || ((b >> 12) & 0xf) == mx || ((b >> 48) & 0xf) == mx || (b >> 60) == mx) {
    return static_cast<double>(corner_weight * static_cast<std::int64_t>(mx));
  }
  return 0;
}

double evaluate(Bitboard b, const LineTable& t, std::int64_t corner_weight) noexcept {
  double v = t[static_cast<std::uint16_t>(b)] + t[static_cast<std::uint16_t>(b >> 16)] +
             t[static_cast<std::uint16_t>(b >> 32)] + t[static_cast<std::uint16_t>(b >> 48)] + t[column(b, 0)] +
             t[column(b, 1)] + t[column(b, 2)] + t[column(b, 3)];
  if (corner_weight != 0) v += corner_term(b, corner_weight);
  return v;
}

json::Value Breakdown::to_json() const {
  json::Object o = lines.to_json();
  o.set("corner", corner);
  o.set("total", total);
  return o;
}

Breakdown heuristic_breakdown(Bitboard b, const Weights& w) {
  const std::array<std::uint16_t, 8> ls = {
      static_cast<std::uint16_t>(b),       static_cast<std::uint16_t>(b >> 16), static_cast<std::uint16_t>(b >> 32),
      static_cast<std::uint16_t>(b >> 48), column(b, 0),                        column(b, 1),
      column(b, 2),                        column(b, 3)};
  Breakdown out;
  for (auto v : ls) {
    const auto f = features(v);
    out.lines.empty += f.empty;
    out.lines.merges += f.merges;
    out.lines.mono += f.mono;
    out.lines.sum += f.sum;
    out.lines.smooth += f.smooth;
    out.lines.stable += f.stable;
  }
  out.corner = corner_term(b, w.corner);
  out.total = evaluate(b, line_table(w), w.corner);
  return out;
}

// ---------------------------------------------------------------- config

namespace {

std::int64_t config_int(std::string_view key, const json::Value& v) {
  if (!v.is_number()) throw std::invalid_argument("config " + std::string(key) + " must be a number");
  try {
    return v.as_int();
  } catch (const json::Error&) {
    throw std::invalid_argument("config " + std::string(key) + " must be an integer (got " + v.dump() + ")");
  }
}

}  // namespace

Config Config::parse(const json::Object* m) {
  Config c = canonical();
  if (m == nullptr) return c;
  for (const auto& [k, v] : *m) {
    if (k == "depth") {
      if (v.is_string()) {
        if (v.as_string() != "auto") throw std::invalid_argument("config depth must be an integer or \"auto\"");
        c.auto_depth = true;
      } else {
        auto n = config_int(k, v);
        if (n < 1) throw std::invalid_argument("config depth must be >= 1");
        c.auto_depth = false;
        c.depth = static_cast<int>(n);
      }
    } else if (k == "minDepth") {
      c.min_depth = static_cast<int>(config_int(k, v));
    } else if (k == "maxDepth") {
      c.max_depth = static_cast<int>(config_int(k, v));
    } else if (k == "fourPruneEmpties") {
      c.four_prune_empties = static_cast<int>(config_int(k, v));
    } else if (k == "timeBudgetMs") {
      if (!v.is_number()) throw std::invalid_argument("config timeBudgetMs must be a number");
      c.time_budget_ms = v.as_double();
    } else if (k == "ttBits") {
      auto n = config_int(k, v);
      if (n < 4 || n > 28) throw std::invalid_argument("config ttBits out of range");
      c.tt_bits = static_cast<int>(n);
    } else if (k == "weights") {
      if (!v.is_object()) throw std::invalid_argument("config weights must be an object");
      for (const auto& [wk, wv] : v.as_object()) {
        std::int64_t n = 0;
        try {
          n = config_int("weights." + wk, wv);
        } catch (const std::invalid_argument&) {
          throw std::invalid_argument("heuristic weight '" + wk + "' must be an integer (got " + wv.dump() + ")");
        }
        if (wk == "lost") c.weights.lost = n;
        else if (wk == "empty") c.weights.empty = n;
        else if (wk == "merges") c.weights.merges = n;
        else if (wk == "mono") c.weights.mono = n;
        else if (wk == "sum") c.weights.sum = n;
        else if (wk == "smooth") c.weights.smooth = n;
        else if (wk == "stable") c.weights.stable = n;
        else if (wk == "corner") c.weights.corner = n;
      }
    }
  }
  return c;
}

json::Value Config::to_json() const {
  return json::Object{{"depth", auto_depth ? json::Value("auto") : json::Value(depth)},
                      {"minDepth", min_depth},
                      {"maxDepth", max_depth},
                      {"fourPruneEmpties", four_prune_empties},
                      {"timeBudgetMs", time_budget_ms},
                      {"ttBits", tt_bits},
                      {"weights", weights.to_json()}};
}

// ---------------------------------------------------------------- transposition table

TranspositionTable::TranspositionTable(int bits)
    : mask_(static_cast<std::uint32_t>((std::size_t{1} << bits) - 1)),
      entries_(std::make_unique<Entry[]>(std::size_t{1} << bits)) {}  // value-initialised: all empty

void TranspositionTable::clear() noexcept {
  const std::size_t n = capacity();
  for (std::size_t i = 0; i < n; ++i) entries_[i].depth = 0;
  size_ = 0;
}

// ---------------------------------------------------------------- search

std::int64_t round_us(std::chrono::steady_clock::duration d) noexcept {
  const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(d).count();
  return static_cast<std::int64_t>(std::llround(static_cast<double>(ns) / 1000.0));
}

Search::Search(Config c)
    : config_(std::move(c)),
      table_(&line_table(config_.weights)),
      corner_(config_.weights.corner),
      tt_(config_.tt_bits == 0 ? 20 : config_.tt_bits) {
  if (config_.tt_bits == 0) config_.tt_bits = 20;
}

int Search::depth_for(Bitboard b) const noexcept {
  if (!config_.auto_depth) return config_.depth;
  return std::max(config_.min_depth, std::min(config_.max_depth, distinct_ranks(b) - 2));
}

double Search::maxnode(Bitboard b, int d) {
  ++nodes_;
  if (d == 0) return ai::evaluate(b, *table_, corner_);
  double best = 0.0;
  for (int dir = 0; dir < 4; ++dir) {
    const Bitboard nb = move(b, dir);
    if (nb == b) continue;
    const double v = chance(nb, d);
    if (aborted_) return 0;
    if (v > best) best = v;
  }
  return best;
}

double Search::chance(Bitboard b, int d) {
  ++nodes_;
  if (timed_ && (nodes_ & 0xfff) == 0 && std::chrono::steady_clock::now() > deadline_) {
    aborted_ = true;
    return 0;
  }
  const std::uint32_t home = tt_.slot(b, d);
  double cached = 0;
  if (tt_.lookup(b, d, home, cached)) {
    ++tt_hits_;
    return cached;
  }

  // Bit 4i of `empties` is set iff cell i is empty; iterating its set bits
  // low-to-high visits empty cells in ascending index order.
  constexpr Bitboard kLowNibbleBits = 0x1111111111111111ull;
  Bitboard x = b | (b >> 2);
  x |= x >> 1;
  Bitboard empties = ~x & kLowNibbleBits;
  const int n = std::popcount(empties);
  const int p = config_.four_prune_empties;
  const bool four = !(p > 0 && n >= p);
  double sum = 0.0;
  for (; empties != 0; empties &= empties - 1) {
    const int sh = std::countr_zero(empties);
    // Built with -ffp-contract=off: each product is rounded before the add (no FMA),
    // keeping values bit-identical to the TypeScript reference.
    if (four) {
      const double v2 = maxnode(b | (Bitboard{1} << sh), d - 1);
      if (aborted_) return 0;
      sum = sum + 0.9 * v2;
      const double v4 = maxnode(b | (Bitboard{2} << sh), d - 1);
      if (aborted_) return 0;
      sum = sum + 0.1 * v4;
    } else {
      const double v2 = maxnode(b | (Bitboard{1} << sh), d - 1);
      if (aborted_) return 0;
      sum = sum + v2;
    }
  }
  const double v = sum / static_cast<double>(n);
  tt_.store(b, d, home, v);
  return v;
}

bool Search::root(Bitboard b, int depth, RootResult& out) {
  RootResult r;
  r.value = -std::numeric_limits<double>::infinity();
  for (int dir = 0; dir < 4; ++dir) {
    const Bitboard nb = move(b, dir);
    if (nb == b) continue;
    const double v = chance(nb, depth);
    if (aborted_) return false;
    r.values[static_cast<std::size_t>(dir)] = v;
    if (v > r.value) {
      r.value = v;
      r.move = dir;
    }
  }
  out = r;
  return true;
}

SearchResult Search::run(Bitboard b) {
  const auto start = std::chrono::steady_clock::now();
  nodes_ = 0;
  tt_hits_ = 0;
  aborted_ = false;
  timed_ = false;
  if (static_cast<double>(tt_.size()) > static_cast<double>(tt_.capacity()) * 0.75) tt_.clear();

  RootResult best;
  int depth = 0;
  std::vector<int> completed;
  bool det = true;
  if (config_.time_budget_ms <= 0) {
    depth = depth_for(b);
    root(b, depth, best);
    completed.push_back(depth);
  } else {
    det = false;
    root(b, 1, best);
    depth = 1;
    completed.push_back(1);
    timed_ = true;
    deadline_ = start + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                            std::chrono::duration<double, std::milli>(config_.time_budget_ms));
    for (int d = 2; d <= config_.max_depth; ++d) {
      RootResult r;
      if (!root(b, d, r)) break;
      best = r;
      depth = d;
      completed.push_back(d);
    }
    timed_ = false;
    aborted_ = false;
  }
  SearchResult res;
  res.move = best.move;
  res.value = best.value;
  res.values = best.values;
  res.depth = depth;
  res.nodes = nodes_;
  res.tt_hits = tt_hits_;
  res.tt_size = tt_.size();
  res.time_us = round_us(std::chrono::steady_clock::now() - start);
  res.deterministic = det;
  res.completed_depths = std::move(completed);
  return res;
}

// ---------------------------------------------------------------- agents

json::Value Metrics::to_json() const {
  json::Object o;
  if (depth) o.set("depth", *depth);
  if (nodes) o.set("nodes", *nodes);
  if (tt_hits) o.set("ttHits", *tt_hits);
  if (tt_size) o.set("ttSize", *tt_size);
  o.set("timeUs", time_us);
  if (values) {
    json::Array a;
    for (const auto& v : *values) a.push_back(v ? json::Value(*v) : json::Value(nullptr));
    o.set("values", std::move(a));
  }
  if (heuristic) o.set("heuristic", heuristic->to_json());
  o.set("deterministic", deterministic);
  if (!completed_depths.empty()) {
    json::Array a;
    for (int d : completed_depths) a.emplace_back(d);
    o.set("completedDepths", std::move(a));
  }
  return o;
}

Decision RandomAgent::decide(const Board& board) {
  const auto t = std::chrono::steady_clock::now();
  std::array<int, 4> valid{};
  std::size_t n = 0;
  for (int d = 0; d < 4; ++d) {
    if (board.can_move(d)) valid[n++] = d;
  }
  Decision dec;
  dec.move = valid[rng_.below(n)];
  dec.metrics.time_us = round_us(std::chrono::steady_clock::now() - t);
  return dec;
}

Decision GreedyAgent::decide(const Board& board) {
  const auto t = std::chrono::steady_clock::now();
  const Bitboard b = from_board(board);
  int best = -1;
  if (auto v = board.valid_moves(); !v.empty()) best = v.front();
  int best_score = -1;
  for (int d = 0; d < 4; ++d) {
    const Bitboard nb = move(b, d);
    if (nb == b) continue;
    int empty = 0;
    for (int i = 0; i < 16; ++i) {
      if (((nb >> (4 * i)) & 0xf) == 0) ++empty;
    }
    if (empty > best_score) {
      best_score = empty;
      best = d;
    }
  }
  Decision dec;
  dec.move = best;
  dec.metrics.time_us = round_us(std::chrono::steady_clock::now() - t);
  return dec;
}

Decision ExpectimaxAgent::decide(const Board& board) {
  const Bitboard b = from_board(board);
  last_ = search_.run(b);
  Decision dec;
  dec.move = last_.move;
  if (dec.move < 0) {
    if (auto v = board.valid_moves(); !v.empty()) dec.move = v.front();
  }
  auto& m = dec.metrics;
  m.depth = last_.depth;
  m.nodes = last_.nodes;
  m.tt_hits = last_.tt_hits;
  m.tt_size = last_.tt_size;
  m.time_us = last_.time_us;
  m.values = last_.values;
  m.heuristic = heuristic_breakdown(b, search_.config().weights);
  m.deterministic = last_.deterministic;
  m.completed_depths = last_.completed_depths;
  return dec;
}

std::unique_ptr<Agent> make_agent(std::string_view id, const json::Object* config) {
  if (id == "random") return std::make_unique<RandomAgent>();
  if (id == "greedy") return std::make_unique<GreedyAgent>();
  if (id == "expectimax") return std::make_unique<ExpectimaxAgent>(Config::parse(config));
  throw std::invalid_argument("unknown agent '" + std::string(id) + "'");
}

}  // namespace g2048::ai
