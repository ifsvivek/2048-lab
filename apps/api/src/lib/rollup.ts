/**
 * Daily analytics rollup (cron trigger). Each step reads only indexed day
 * partitions except the players snapshot, which is one pass per day.
 *
 *   player_daily  active / new / returning players + session stats per day
 *   retention     D1 / D7 / D30 for the last 31 cohorts
 *   snapshot      per-player aggregates (games/player, tile reach by player…)
 */
import { REACH } from './analytics.ts';
import { log } from './log.ts';

const DAY = 86_400_000;
const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => iso(Date.parse(day) + n * DAY);

export async function rollupDay(db: D1Database, day: string): Promise<void> {
  const [active, fresh, sess] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM player_days WHERE day = ?1').bind(day),
    db.prepare('SELECT COUNT(*) AS n FROM players WHERE first_day = ?1').bind(day),
    db.prepare('SELECT COUNT(*) AS n, AVG(last_at - started_at) AS avg FROM sessions WHERE day = ?1').bind(day),
  ]);
  const a = (active.results[0] as { n: number }).n;
  const n = (fresh.results[0] as { n: number }).n;
  const s = sess.results[0] as { n: number; avg: number | null };
  await db
    .prepare(
      `INSERT INTO player_daily (day, active, new_players, returning_players, sessions, avg_session_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(day) DO UPDATE SET active = excluded.active, new_players = excluded.new_players, returning_players = excluded.returning_players,
         sessions = excluded.sessions, avg_session_ms = excluded.avg_session_ms`,
    )
    .bind(day, a, n, Math.max(0, a - n), s.n, s.avg)
    .run();
}

export async function rollupRetention(db: D1Database, today: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (let back = 1; back <= 31; back++) {
    const cohort = addDays(today, -back);
    const retained = (offset: number) =>
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM player_days pd JOIN players p ON p.id = pd.player_id
           WHERE p.first_day = ?1 AND pd.day = ?2`,
        )
        .bind(cohort, addDays(cohort, offset));
    const [size, d1, d7, d30] = await db.batch([
      db.prepare('SELECT COUNT(*) AS n FROM players WHERE first_day = ?1').bind(cohort),
      retained(1),
      retained(7),
      retained(30),
    ]);
    const nsize = (size.results[0] as { n: number }).n;
    if (!nsize) continue;
    const val = (r: D1Result, offset: number) => (back > offset ? (r.results[0] as { n: number }).n : null);
    stmts.push(
      db
        .prepare(
          `INSERT INTO retention (cohort_day, size, d1, d7, d30, computed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(cohort_day) DO UPDATE SET size = excluded.size, d1 = excluded.d1, d7 = excluded.d7, d30 = excluded.d30, computed_at = excluded.computed_at`,
        )
        .bind(cohort, nsize, val(d1, 1), val(d7, 7), val(d30, 30), Date.now()),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

export async function rollupPlayerSnapshot(db: D1Database): Promise<void> {
  const reachCols = REACH.map((t) => `SUM(best_tile >= ${t}) AS r${t}`).join(', ');
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS players, SUM(games) AS games, AVG(games) AS avg_games,
              AVG(CAST(total_score AS REAL) / games) AS avg_player_score, AVG(best_score) AS avg_best_score,
              MAX(best_score) AS best_score, SUM(games > 1) AS multi_game, ${reachCols}
       FROM players WHERE games > 0`,
    )
    .first<Record<string, number>>();
  await db
    .prepare('INSERT INTO analytics_snapshot (key, value, computed_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, computed_at = excluded.computed_at')
    .bind('players', JSON.stringify(row ?? {}), Date.now())
    .run();
}

/** Full rollup: yesterday + today (partial), retention, snapshot. Idempotent. */
export async function runRollup(db: D1Database, now = Date.now()): Promise<void> {
  const today = iso(now);
  const t0 = Date.now();
  // Yesterday and today always; older days only if never rolled up (backfill, bounded to 60 days).
  const { results } = await db.prepare('SELECT day FROM player_daily WHERE day >= ?1').bind(addDays(today, -60)).all<{ day: string }>();
  const have = new Set(results.map((r) => r.day));
  for (let back = 60; back >= 0; back--) {
    const day = addDays(today, -back);
    if (back <= 1 || !have.has(day)) await rollupDay(db, day);
  }
  await rollupRetention(db, today);
  await rollupPlayerSnapshot(db);
  log('info', 'analytics.rollup', { today, ms: Date.now() - t0 });
}
