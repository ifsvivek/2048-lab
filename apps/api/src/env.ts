import type { BenchmarkSession } from './do/benchmark-session.ts';
import type { GameSession } from './do/game-session.ts';

export interface Env {
  DB: D1Database;
  GAME: DurableObjectNamespace<GameSession>;
  BENCH: DurableObjectNamespace<BenchmarkSession>;
  CREATE_LIMITER?: RateLimit;
  WRITE_LIMITER?: RateLimit;
  MIN_STORE_MOVES: string;
  LIVE_IDLE_TIMEOUT_MS: string;
  MAX_SERVER_BENCH_GAMES: string;
  MAX_MOVES_PER_GAME: string;
}
