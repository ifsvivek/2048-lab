/**
 * GameSession — one Durable Object per *live server-side game*.
 *
 * Why a Durable Object here (docs/adr/0002-durable-objects.md):
 *  - Move ordering: concurrent requests for one game must serialise; a DO is a
 *    single-threaded actor, so no D1 locking or version columns are needed.
 *  - Write cost: each move *request* is one SQLite row in the object's own
 *    storage (a batch of N moves is still one row), persisted before the
 *    response is released (output gate), and the game is written to D1 exactly
 *    once when it ends. Per-move D1 writes would exhaust the free tier
 *    (100k rows/day) after a handful of AI games.
 *  - Spectators: hibernatable WebSockets fan out each move batch without
 *    polling, and cost nothing while idle.
 *  - Server-driven agents (push protocol / built-ins) run from alarms.
 *
 * Human games in the browser do NOT use this: they run locally (offline-first)
 * and upload one verified replay when finished.
 */
import { DurableObject } from 'cloudflare:workers';
import { type Direction, DIRECTION_NAMES, Game, SPEC_VERSION, maxExponent, parseDirection, simulate } from '@g2048/engine';
import { RandomAgent } from '@g2048/engine/ai';
import type { Env } from '../env.ts';
import { type GameRecord, rollupStatements, upsertGame } from '../lib/db.ts';
import { type Driver, type DriverSpec, createDriver } from '../lib/driver.ts';
import { ApiError, encodeRpcError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { type LastMove, type PlayerInfo, type PublicGameState, spawnInfo, stateFromGame } from '../lib/state.ts';

export interface SessionMeta {
  gameId: string;
  replayCode: string;
  seed: number;
  source: string;
  player: PlayerInfo;
  agentConfig: Record<string, unknown> | null;
  runtime: Record<string, unknown> | null;
  startedAt: number;
  driver: (DriverSpec & { maxMoves: number; delayMs: number }) | null;
}

export interface LiveReplay {
  state: PublicGameState;
  moves: string;
  timing: number[];
  agentConfig: Record<string, unknown> | null;
  runtime: Record<string, unknown> | null;
  source: string;
}

export interface MoveOutcome {
  state: PublicGameState;
  applied: number;
  rejected: { index: number; move: string; reason: 'INVALID_MOVE' | 'GAME_OVER' } | null;
}

const DRIVER_BATCH_MS = 20;
const DRIVER_REMOTE_CALLS = 15;

export class GameSession extends DurableObject<Env> {
  private meta: SessionMeta | null = null;
  private game: Game | null = null;
  private timing: number[] = [];
  private finished: 'over' | 'abandoned' | null = null;
  private lastMove: LastMove | null = null;
  private lastActivity = Date.now();
  private alarmAt: number | null = null;
  private driver: Driver | null = null;
  private driverFailures = 0;
  private finishedAt: number | null = null;
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Restore in-memory state from SQLite before any request is delivered.
    ctx.blockConcurrencyWhile(async () => {
      this.restore();
      this.alarmAt = await ctx.storage.getAlarm();
    });
  }

  /** Rebuild the game from durable storage (the source of truth). */
  private restore(): void {
    this.meta = null;
    this.game = null;
    this.timing = [];
    const hasSchema = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    if (!hasSchema) return;
    const row = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'meta'").toArray()[0];
    if (!row) return;
    const meta = JSON.parse(row.v) as SessionMeta;
    let moves = '';
    for (const b of this.sql.exec<{ moves: string; timing: string | null }>('SELECT moves, timing FROM batches ORDER BY seq')) {
      moves += b.moves;
      const t = b.timing ? (JSON.parse(b.timing) as number[]) : [];
      for (let i = 0; i < b.moves.length; i++) this.timing.push(t[i] ?? 0);
    }
    this.meta = meta;
    this.game = simulate(meta.seed, moves);
  }

  private require(): { meta: SessionMeta; game: Game } {
    if (!this.meta || !this.game) throw encodeRpcError(new ApiError('GAME_NOT_FOUND', 'The supplied gameId does not exist.'));
    return { meta: this.meta, game: this.game };
  }

  private state(): PublicGameState {
    const { meta, game } = this.require();
    return stateFromGame(
      game,
      { gameId: meta.gameId, replayCode: meta.replayCode, player: meta.player, startedAt: meta.startedAt, finishedAt: this.finishedAt, status: this.finished ?? 'active' },
      this.lastMove,
    );
  }

  // ------------------------------------------------------------------ RPC

  async create(meta: SessionMeta): Promise<PublicGameState> {
    if (this.meta) throw encodeRpcError(new ApiError('CONFLICT', 'game already exists'));
    // Schema is created only for real games, so probing unknown IDs writes nothing.
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS batches (seq INTEGER PRIMARY KEY AUTOINCREMENT, moves TEXT NOT NULL, timing TEXT)');
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('meta', ?)", JSON.stringify(meta));
    this.meta = meta;
    this.game = new Game(meta.seed);
    this.timing = [];
    await upsertGame(this.env.DB, this.record('live')).run();
    await this.schedule(meta.driver ? Date.now() : null);
    log('info', 'game.created', { gameId: meta.gameId, source: meta.source, driver: meta.driver?.type ?? null, agent: meta.player.name });
    return this.state();
  }

  async getState(): Promise<PublicGameState | null> {
    return this.meta ? this.state() : null;
  }

  /** Replay-so-far of a live game (moves + timing + current state). */
  async getLiveReplay(): Promise<LiveReplay | null> {
    if (!this.meta || !this.game) return null;
    return { state: this.state(), moves: this.game.moves, timing: this.timing, agentConfig: this.meta.agentConfig, runtime: this.meta.runtime, source: this.meta.source };
  }

  /** Apply moves in order, stopping at the first invalid one. */
  async submitMoves(moves: (string | number)[], timing?: number[], metrics?: Record<string, unknown>): Promise<MoveOutcome> {
    const { meta, game } = this.require();
    if (meta.driver) throw encodeRpcError(new ApiError('CONFLICT', 'this game is driven by the platform; moves cannot be submitted'));
    if (this.finished || game.over) {
      throw encodeRpcError(new ApiError('GAME_OVER', 'The game is over; no further moves are accepted.', { state: this.state() }));
    }
    const dirs: Direction[] = [];
    for (const m of moves) {
      try {
        dirs.push(parseDirection(m));
      } catch {
        throw encodeRpcError(new ApiError('BAD_REQUEST', `invalid move '${m}'; expected up, down, left or right`));
      }
    }
    const outcome = await this.applyMoves(dirs, timing, metrics);
    if (outcome.applied === 0 && outcome.rejected?.reason === 'INVALID_MOVE') {
      throw encodeRpcError(
        new ApiError('INVALID_MOVE', `Move '${outcome.rejected.move}' does not change the board. Choose one of validMoves.`, { state: outcome.state }),
      );
    }
    return outcome;
  }

  /** End a live game early (e.g. the agent gives up). */
  async resign(): Promise<PublicGameState> {
    this.require();
    if (!this.finished) await this.finalize(this.game!.over ? 'over' : 'abandoned');
    return this.state();
  }

  // ------------------------------------------------------------ internals

  private async applyMoves(dirs: Direction[], timing?: number[], metrics?: Record<string, unknown>): Promise<MoveOutcome> {
    const game = this.game!;
    const from = game.moveCount;
    let applied = 0;
    let rejected: MoveOutcome['rejected'] = null;
    const letters: string[] = [];
    for (let i = 0; i < dirs.length; i++) {
      if (game.over) {
        rejected = { index: i, move: DIRECTION_NAMES[dirs[i]], reason: 'GAME_OVER' };
        break;
      }
      const step = game.apply(dirs[i]);
      if (!step) {
        rejected = { index: i, move: DIRECTION_NAMES[dirs[i]], reason: 'INVALID_MOVE' };
        break;
      }
      this.lastMove = { move: DIRECTION_NAMES[dirs[i]], gained: step.gained, spawn: spawnInfo(step.spawn) };
      const t = timing?.[i];
      this.timing.push(typeof t === 'number' && Number.isFinite(t) && t >= 0 ? Math.round(t) : 0);
      letters.push('UDLR'[dirs[i]]);
      applied++;
    }
    const maxMoves = Number(this.env.MAX_MOVES_PER_GAME) || 100000;
    if (applied > 0) {
      // Persist before anything observes the new state. sql.exec is synchronous and
      // the output gate holds the response until the write is durable.
      try {
        const t = this.timing.slice(from);
        this.sql.exec('INSERT INTO batches (moves, timing) VALUES (?, ?)', letters.join(''), t.some((x) => x > 0) ? JSON.stringify(t) : null);
      } catch (e) {
        this.restore(); // roll memory back to what is durable
        throw e;
      }
      this.lastActivity = Date.now();
      this.broadcast({ type: 'moves', from, moves: letters.join(''), score: game.score, moveNumber: game.moveCount, over: game.over, metrics: metrics ?? null });
    }
    if (game.over || game.moveCount >= maxMoves) {
      await this.finalize(game.over ? 'over' : 'abandoned');
    }
    return { state: this.state(), applied, rejected };
  }

  private async schedule(at: number | null): Promise<void> {
    const idle = Number(this.env.LIVE_IDLE_TIMEOUT_MS) || 86_400_000;
    const next = at ?? this.lastActivity + idle;
    if (this.alarmAt === next) return;
    this.alarmAt = next;
    await this.ctx.storage.setAlarm(next);
  }

  private record(status: GameRecord['status']): GameRecord {
    const { meta, game } = this.require();
    return {
      id: meta.gameId,
      replayCode: meta.replayCode,
      status,
      source: meta.source,
      seed: meta.seed,
      moves: game.moves,
      timing: this.timing.some((t) => t > 0) ? this.timing : null,
      score: game.score,
      maxTile: 2 ** maxExponent(game.board),
      moveCount: game.moveCount,
      finalBoard: game.snapshot().board,
      historyHash: game.historyHash,
      playerKind: meta.player.kind,
      agentId: meta.player.agentId ?? null,
      agentName: meta.player.name ?? null,
      agentVersion: meta.player.version ?? null,
      agentConfig: meta.agentConfig,
      runtime: meta.runtime,
      startedAt: meta.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  private async finalize(status: 'over' | 'abandoned'): Promise<void> {
    if (this.finished) return;
    this.finished = status;
    this.finishedAt = Date.now();
    const rec = this.record(status);
    const min = Number(this.env.MIN_STORE_MOVES) || 10;
    if (status === 'abandoned' && rec.moveCount < min) {
      // Not worth keeping: drop the placeholder row instead of storing noise.
      await this.env.DB.prepare('DELETE FROM games WHERE id = ?1').bind(rec.id).run();
    } else {
      await this.env.DB.batch([upsertGame(this.env.DB, rec), ...rollupStatements(this.env.DB, rec)]);
    }
    this.broadcast({ type: 'end', status, state: this.state() });
    log('info', 'game.finished', { gameId: rec.id, status, score: rec.score, moves: rec.moveCount, maxTile: rec.maxTile, source: rec.source });
    // The D1 row is now authoritative; free the DO's storage.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.alarmAt = null;
  }

  private getDriver(): Driver {
    const { meta, game } = this.require();
    if (!this.driver) {
      this.driver = createDriver(meta.driver!, meta.seed);
      // Built-in random agent carries RNG state: fast-forward it through history.
      if (meta.driver!.type === 'builtin' && meta.driver!.agent === 'random' && game.moveCount > 0) {
        const agent = new RandomAgent();
        agent.reset({ seed: meta.seed, specVersion: SPEC_VERSION });
        const replay = new Game(meta.seed);
        for (const ch of game.moves) {
          agent.decide({ board: replay.board, score: replay.score, moveCount: replay.moveCount, meta: { seed: meta.seed, specVersion: SPEC_VERSION } });
          replay.apply('UDLR'.indexOf(ch) as Direction);
        }
        this.driver = {
          remote: false,
          async decide(g) {
            const d = agent.decide({ board: g.board, score: g.score, moveCount: g.moveCount, meta: { seed: meta.seed, specVersion: SPEC_VERSION } });
            return { moves: [d.move], metrics: d.metrics };
          },
        };
      }
    }
    return this.driver;
  }

  private async driveBatch(): Promise<void> {
    const { meta, game } = this.require();
    const driver = this.getDriver();
    const start = Date.now();
    let calls = 0;
    while (!game.over && game.moveCount < meta.driver!.maxMoves) {
      if (driver.remote ? calls >= DRIVER_REMOTE_CALLS : Date.now() - start >= DRIVER_BATCH_MS) break;
      calls++;
      let decision;
      try {
        decision = await driver.decide(game, meta.gameId);
        this.driverFailures = 0;
      } catch (e) {
        this.driverFailures++;
        log('warn', 'driver.error', { gameId: meta.gameId, failures: this.driverFailures, message: (e as Error).message });
        if (this.driverFailures >= 3) {
          this.broadcast({ type: 'error', code: 'AGENT_UNREACHABLE', message: (e as Error).message });
          await this.finalize('abandoned');
          return;
        }
        break;
      }
      const timeUs = typeof decision.metrics?.timeUs === 'number' ? decision.metrics.timeUs : 0;
      const out = await this.applyMoves(decision.moves, decision.moves.map(() => timeUs), decision.metrics as Record<string, unknown>);
      if (out.applied === 0) {
        this.driverFailures++;
        if (this.driverFailures >= 3) {
          this.broadcast({ type: 'error', code: 'INVALID_MOVE', message: 'agent returned invalid moves' });
          await this.finalize('abandoned');
          return;
        }
      }
      if (meta.driver!.delayMs > 0) break; // paced for spectators: one decision per alarm
    }
    if (!this.finished && game.moveCount >= meta.driver!.maxMoves) await this.finalize('abandoned');
  }

  /**
   * Alarms drive platform-run agents and expire idle games. The handler is
   * idempotent: it derives everything from durable state, so a retried or
   * duplicate alarm just continues where the last committed batch left off.
   */
  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    this.alarmAt = null;
    if (!this.meta || !this.game || this.finished) return;
    try {
      if (this.meta.driver) {
        await this.driveBatch();
        if (!this.finished) await this.schedule(Date.now() + Math.max(this.meta.driver.delayMs, 0));
        return;
      }
      const idle = Number(this.env.LIVE_IDLE_TIMEOUT_MS) || 86_400_000;
      if (Date.now() - this.lastActivity >= idle) await this.finalize(this.game.over ? 'over' : 'abandoned');
      else await this.schedule(null);
    } catch (e) {
      log('error', 'game.alarm_failed', { gameId: this.meta.gameId, retryCount: info?.retryCount ?? 0, message: (e as Error).message });
      // Back off ourselves instead of burning the runtime's limited automatic retries.
      await this.schedule(Date.now() + Math.min(60_000, 1000 * 2 ** (info?.retryCount ?? 0)));
    }
  }

  // ---------------------------------------------------- spectator sockets

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!this.meta || !this.game) return Response.json(new ApiError('GAME_NOT_FOUND', 'game is not live').toJSON(), { status: 404 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: 'hello', state: this.state(), seed: this.meta.seed, moves: this.game.moves, spectators: this.ctx.getWebSockets().length }));
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

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      /* already closed */
    }
  }

  private broadcast(msg: unknown): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const data = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        /* socket closing */
      }
    }
  }
}
