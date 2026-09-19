/** D1 access. Every write path is a single `batch()` so it is one round trip. */
import { type Replay, SPEC_VERSION, boardFromHex, classifyGameRef, maxTile } from '@g2048/engine';
import type { GameRow } from './state.ts';

export interface GameRecord {
  id: string;
  replayCode: string;
  status: 'live' | 'over' | 'abandoned';
  source: string;
  seed: number;
  moves: string;
  timing: number[] | null;
  score: number;
  maxTile: number;
  moveCount: number;
  finalBoard: string;
  historyHash: string;
  playerKind: 'human' | 'agent';
  agentId: string | null;
  agentName: string | null;
  agentVersion: string | null;
  agentConfig: Record<string, unknown> | null;
  runtime: Record<string, unknown> | null;
  startedAt: number;
  finishedAt: number | null;
}

const REACH = [2048, 4096, 8192, 16384, 32768, 65536];

function json(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

export function upsertGame(db: D1Database, g: GameRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO games (id, replay_code, status, source, spec_version, seed, moves, timing, score, max_tile, move_count,
         final_board, history_hash, player_kind, agent_id, agent_name, agent_version, agent_config, runtime,
         started_at, finished_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, moves = excluded.moves, timing = excluded.timing,
         score = excluded.score, max_tile = excluded.max_tile, move_count = excluded.move_count,
         final_board = excluded.final_board, history_hash = excluded.history_hash, finished_at = excluded.finished_at`,
    )
    .bind(
      g.id,
      g.replayCode,
      g.status,
      g.source,
      SPEC_VERSION,
      g.seed,
      g.moves,
      json(g.timing),
      g.score,
      g.maxTile,
      g.moveCount,
      g.finalBoard,
      g.historyHash,
      g.playerKind,
      g.agentId,
      g.agentName,
      g.agentVersion,
      json(g.agentConfig),
      json(g.runtime),
      g.startedAt,
      g.finishedAt,
      Date.now(),
    );
}

/** Statements that roll a finished game into the aggregates (stats_daily + agent counters). */
export function rollupStatements(db: D1Database, g: GameRecord): D1PreparedStatement[] {
  const day = new Date(g.finishedAt ?? Date.now()).toISOString().slice(0, 10);
  const r = REACH.map((t) => (g.maxTile >= t ? 1 : 0));
  const stmts = [
    db
      .prepare(
        `INSERT INTO stats_daily (day, player_kind, games, total_score, total_moves, best_score, best_tile,
           r2048, r4096, r8192, r16384, r32768, r65536)
         VALUES (?1, ?2, 1, ?3, ?4, ?3, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(day, player_kind) DO UPDATE SET games = games + 1,
           total_score = total_score + excluded.total_score, total_moves = total_moves + excluded.total_moves,
           best_score = MAX(best_score, excluded.best_score), best_tile = MAX(best_tile, excluded.best_tile),
           r2048 = r2048 + excluded.r2048, r4096 = r4096 + excluded.r4096, r8192 = r8192 + excluded.r8192,
           r16384 = r16384 + excluded.r16384, r32768 = r32768 + excluded.r32768, r65536 = r65536 + excluded.r65536`,
      )
      .bind(day, g.playerKind, g.score, g.moveCount, g.maxTile, ...r),
  ];
  if (g.agentId) {
    const reached = REACH.filter((t) => g.maxTile >= t);
    const reachedExpr = reached.reduce(
      (acc, t) => `json_set(${acc}, '$."${t}"', COALESCE(json_extract(reached, '$."${t}"'), 0) + 1)`,
      'reached',
    );
    stmts.push(
      db
        .prepare(
          `UPDATE agents SET games_played = games_played + 1, total_score = total_score + ?1,
             best_score = MAX(best_score, ?1), best_tile = MAX(best_tile, ?2), total_moves = total_moves + ?3,
             reached = ${reachedExpr}, last_seen_at = ?4
           WHERE id = ?5`,
        )
        .bind(g.score, g.maxTile, g.moveCount, Date.now(), g.agentId),
    );
  }
  return stmts;
}

export async function getGameRow(db: D1Database, ref: string): Promise<GameRow | null> {
  const c = classifyGameRef(ref);
  if (!c) return null;
  const col = c.kind === 'id' ? 'id' : 'replay_code';
  return db.prepare(`SELECT * FROM games WHERE ${col} = ?1`).bind(c.value).first<GameRow>();
}

export function rowToReplay(row: GameRow): Replay & { status: string; source: string } {
  const board = boardFromHex(row.final_board ?? '0000000000000000');
  return {
    specVersion: row.spec_version,
    gameId: row.id,
    replayCode: row.replay_code,
    status: row.status,
    source: row.source,
    seed: row.seed,
    moves: row.moves,
    final: {
      board: row.final_board ?? '',
      score: row.score,
      moveCount: row.move_count,
      maxTile: maxTile(board),
      over: row.status === 'over',
      historyHash: row.history_hash ?? '',
    },
    timing: row.timing ? JSON.parse(row.timing) : undefined,
    playerKind: row.player_kind,
    agent: row.agent_name
      ? { id: row.agent_id ?? undefined, name: row.agent_name, version: row.agent_version ?? undefined, config: row.agent_config ? JSON.parse(row.agent_config) : undefined }
      : undefined,
    runtime: row.runtime ? JSON.parse(row.runtime) : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AgentRow {
  id: string;
  name: string;
  kind: string;
  language: string | null;
  runtime: string | null;
  version: string;
  description: string | null;
  endpoint: string | null;
  key_hash: string;
  games_played: number;
  total_score: number;
  best_score: number;
  best_tile: number;
  total_moves: number;
  reached: string;
  created_at: number;
  last_seen_at: number | null;
}

export function publicAgent(a: AgentRow) {
  const reached = JSON.parse(a.reached || '{}') as Record<string, number>;
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    language: a.language,
    runtime: a.runtime,
    version: a.version,
    description: a.description,
    pushEnabled: !!a.endpoint,
    stats: {
      gamesPlayed: a.games_played,
      totalMoves: a.total_moves,
      avgScore: a.games_played ? Math.round(a.total_score / a.games_played) : 0,
      bestScore: a.best_score,
      bestTile: a.best_tile,
      reachRates: Object.fromEntries(REACH.map((t) => [t, a.games_played ? (reached[t] ?? 0) / a.games_played : 0])),
    },
    createdAt: a.created_at,
    lastSeenAt: a.last_seen_at,
  };
}

export async function agentByKey(db: D1Database, apiKey: string): Promise<AgentRow | null> {
  const h = await sha256Hex(apiKey);
  return db.prepare('SELECT * FROM agents WHERE key_hash = ?1').bind(h).first<AgentRow>();
}
