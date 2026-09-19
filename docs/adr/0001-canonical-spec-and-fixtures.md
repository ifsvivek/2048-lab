# ADR 0001 — One canonical spec, validated by shared fixtures

**Status:** accepted

## Context
The platform compares four language implementations and must replay any game
exactly. "Mostly the same" engines make benchmarks meaningless and replays
untrustworthy.

## Decision
* `spec/SPEC.md` defines every observable behaviour down to the bit: uint32
  xoshiro128** seeded by a MurmurHash3-finalised SplitMix sequence, rejection
  sampling for `below(n)`, spawn order (position then value), line-merge rules,
  the FNV-1a history hash, identifiers.
* The RNG is 32-bit so JavaScript needs no BigInt; the heuristic uses integer
  weights so float64 results are exact; the search pins operation order and
  forbids FMA, so **AI decisions are bit-identical across languages** too
  (`spec/AI.md`).
* The TypeScript engine is the reference that *generates* `spec/fixtures/*`;
  every port *consumes* them. CI fails if regenerated fixtures drift, and
  `pnpm validate` requires identical benchmark checksums from all ports.

## Consequences
* A replay is `(seed, moves)`; servers verify by re-simulation and never trust
  client scores.
* Benchmarks measure speed only: every runtime plays the same games
  (checksums `3d653498`, `33601a3a`, `74c35bae` … are equal everywhere).
* Behaviour changes require a spec version bump and regenerated fixtures.
* Adding a language is mechanical: C, C++, C#, Java and Lua joined the
  original four by passing the same fixtures and reproducing every checksum,
  with no change to the spec.
