/**
 * BenchmarkSession — a server-run benchmark of one agent over N seeds.
 *
 * Why a Durable Object: a benchmark outlives any single request (hundreds of
 * alarm-driven batches), needs one coordinator to own progress, and streams
 * live progress to spectators. Progress is persisted once per batch; D1 is
 * written twice per session (row created as `running`, then completed).
 *
 * Heavy, reproducible cross-language benchmarks run on real hardware via the
 * per-language CLIs and are *submitted* to /v1/benchmarks/runs; server sessions
 * exist to benchmark registered push agents and light built-ins on demand.
 */
import { DurableObject } from 'cloudflare:workers';
import { type Direction, Game, SPEC_VERSION, maxExponent } from '@g2048/engine';
import { type GameResult, summarise, suiteChecksum } from '@g2048/engine/sim';
import type { Env } from '../env.ts';
import { type Driver, type DriverSpec, createDriver } from '../lib/driver.ts';
import { ApiError, encodeRpcError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

export interface BenchConfig {
  benchmarkId: string;
  agentId: string;
  agentName: string;
  driver: DriverSpec;
  games: number;
  seedStart: number;
  maxMoves: number;
  createdAt: number;
}

interface BenchProgress {
  results: GameResult[];
  current: { seed: number; moves: string; nodes: number; startedAt: number } | null;
  decisionUs: number[];
  status: 'running' | 'complete' | 'failed';
  error: string | null;
  wallMs: number;
}

export interface BenchStatus {
  benchmarkId: string;
  status: BenchProgress['status'];
  agent: { id: string; name: string };
  gamesTotal: number;
  gamesCompleted: number;
  current: { seed: number; moveNumber: number; score: number } | null;
  results: GameResult[];
  summary: ReturnType<typeof summarise> | null;
  checksum: string | null;
  error: string | null;
}

const BATCH_MS = 25;
const REMOTE_CALLS = 15;

export class BenchmarkSession extends DurableObject<Env> {
  private config: BenchConfig | null = null;
  private progress: BenchProgress | null = null;
  private game: Game | null = null;
  private driver: Driver | null = null;
  private failures = 0;

  private async load(): Promise<void> {
    if (this.config) return;
    this.config = (await this.ctx.storage.get<BenchConfig>('config')) ?? null;
    this.progress = (await this.ctx.storage.get<BenchProgress>('progress')) ?? null;
  }

  async start(config: BenchConfig): Promise<BenchStatus> {
    await this.load();
    if (this.config) throw encodeRpcError(new ApiError('CONFLICT', 'benchmark already exists'));
    this.config = config;
    this.progress = { results: [], current: null, decisionUs: [], status: 'running', error: null, wallMs: 0 };
    await this.ctx.storage.put({ config, progress: this.progress });
    await this.env.DB.prepare(
      `INSERT INTO benchmark_runs (id, source, status, suite_id, spec_version, language, runtime, runtime_version, platform,
         agent_id, agent_config, environment, deterministic, games, summary, created_at)
       VALUES (?1, 'server', 'running', ?2, ?3, 'typescript', 'workerd', NULL, 'cloudflare', ?4, ?5, '{}', 1, ?6, '{}', ?7)`,
    )
      .bind(config.benchmarkId, `server-${config.games}x`, SPEC_VERSION, config.agentId, JSON.stringify(config.driver), config.games, config.createdAt)
      .run();
    await this.ctx.storage.setAlarm(Date.now());
    log('info', 'bench.started', { benchmarkId: config.benchmarkId, agent: config.agentId, games: config.games });
    return this.status();
  }

  async status(): Promise<BenchStatus> {
    await this.load();
    if (!this.config || !this.progress) throw encodeRpcError(new ApiError('BENCHMARK_NOT_FOUND', 'benchmark not found'));
    const p = this.progress;
    const done = p.status !== 'running';
    return {
      benchmarkId: this.config.benchmarkId,
      status: p.status,
      agent: { id: this.config.agentId, name: this.config.agentName },
      gamesTotal: this.config.games,
      gamesCompleted: p.results.length,
      current: p.current && this.game ? { seed: p.current.seed, moveNumber: this.game.moveCount, score: this.game.score } : null,
      results: p.results,
      summary: p.results.length ? summarise(p.results, p.wallMs, null, null, p.decisionUs.length ? Float64Array.from(p.decisionUs) : null) : null,
      checksum: done && p.results.length ? suiteChecksum(p.results) : null,
      error: p.error,
    };
  }

  override async alarm(): Promise<void> {
    await this.load();
    const cfg = this.config;
    const p = this.progress;
    if (!cfg || !p || p.status !== 'running') return;
    const t0 = Date.now();

    if (!p.current) {
      const seed = (cfg.seedStart + p.results.length) >>> 0;
      p.current = { seed, moves: '', nodes: 0, startedAt: Date.now() };
      this.game = null;
      this.driver = null;
    }
    if (!this.game) {
      this.game = new Game(p.current.seed);
      for (const ch of p.current.moves) this.game.apply('UDLR'.indexOf(ch) as Direction);
    }
    if (!this.driver) this.driver = createDriver(cfg.driver, p.current.seed);
    // Note: after an eviction mid-game a stateful built-in (random) restarts its RNG;
    // server sessions only allow stateless built-ins plus remote agents for that reason.

    const game = this.game;
    const from = game.moveCount;
    let calls = 0;
    while (!game.over && game.moveCount < cfg.maxMoves) {
      if (this.driver.remote ? calls >= REMOTE_CALLS : Date.now() - t0 >= BATCH_MS) break;
      calls++;
      try {
        const d = await this.driver.decide(game, cfg.benchmarkId);
        let applied = 0;
        for (const m of d.moves) {
          if (!game.apply(m)) break;
          applied++;
        }
        if (applied === 0) throw new Error('agent returned an invalid move');
        this.failures = 0;
        p.current.nodes += typeof d.metrics?.nodes === 'number' ? d.metrics.nodes : 0;
        if (typeof d.metrics?.timeUs === 'number' && p.decisionUs.length < 50_000) p.decisionUs.push(d.metrics.timeUs);
      } catch (e) {
        if (++this.failures >= 3) {
          p.status = 'failed';
          p.error = (e as Error).message;
          break;
        }
      }
    }
    p.wallMs += Date.now() - t0;
    p.current.moves = game.moves;
    this.broadcast({ type: 'progress', gameIndex: p.results.length, seed: p.current.seed, from, moves: game.moves.slice(from), score: game.score, moveNumber: game.moveCount, completed: p.results.length });

    if (p.status === 'running' && (game.over || game.moveCount >= cfg.maxMoves)) {
      const r: GameResult = {
        seed: p.current.seed,
        score: game.score,
        maxTile: 2 ** maxExponent(game.board),
        moveCount: game.moveCount,
        over: game.over,
        historyHash: game.historyHash,
        wallMs: Date.now() - p.current.startedAt,
        nodes: p.current.nodes,
      };
      p.results.push(r);
      p.current = null;
      this.game = null;
      this.broadcast({ type: 'game', result: r, completed: p.results.length });
      if (p.results.length >= cfg.games) p.status = 'complete';
    }

    await this.ctx.storage.put('progress', p);
    if (p.status === 'running') {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    await this.complete();
  }

  private async complete(): Promise<void> {
    const cfg = this.config!;
    const s = await this.status();
    const sum = s.summary;
    await this.env.DB.prepare(
      `UPDATE benchmark_runs SET status = ?2, checksum = ?3, games = ?4, avg_score = ?5, max_score = ?6, max_tile = ?7,
         total_moves = ?8, wall_ms = ?9, games_per_sec = ?10, moves_per_sec = ?11, nodes_per_sec = ?12,
         avg_decision_us = ?13, p99_decision_us = ?14, summary = ?15, results = ?16
       WHERE id = ?1`,
    )
      .bind(
        cfg.benchmarkId,
        s.status,
        s.checksum,
        s.gamesCompleted,
        sum?.avgScore ?? null,
        sum?.maxScore ?? null,
        sum?.maxTile ?? null,
        sum?.totalMoves ?? null,
        sum?.wallMs ?? null,
        sum?.gamesPerSec ?? null,
        sum?.movesPerSec ?? null,
        sum?.nodesPerSec ?? null,
        sum?.avgDecisionUs ?? null,
        sum?.p99DecisionUs ?? null,
        JSON.stringify(sum ?? {}),
        JSON.stringify(s.results.map((r) => [r.seed, r.score, r.maxTile, r.moveCount, r.historyHash])),
      )
      .run();
    this.broadcast({ type: 'end', status: s });
    log('info', 'bench.finished', { benchmarkId: cfg.benchmarkId, status: s.status, games: s.gamesCompleted, avgScore: sum?.avgScore });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.load();
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!this.config) return Response.json(new ApiError('BENCHMARK_NOT_FOUND', 'benchmark not found').toJSON(), { status: 404 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: 'hello', status: await this.status(), current: this.progress?.current ?? null }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === 'ping') ws.send('pong');
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* closing */
      }
    }
  }
}
