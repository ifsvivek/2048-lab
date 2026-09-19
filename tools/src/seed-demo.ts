/**
 * Seeds a LOCAL API with realistic synthetic history so the analytics
 * dashboards can be exercised end-to-end. Refuses non-localhost targets.
 *
 *   node tools/src/seed-demo.ts [http://localhost:8787]
 */
import { Game, Rng, type Direction, validMoves } from '@g2048/engine';
import { ExpectimaxAgent, GreedyAgent } from '@g2048/engine/ai';
import { playSync } from '@g2048/engine/sim';

const BASE = process.argv[2] ?? 'http://localhost:8787';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error('seed-demo only targets a local API (refusing to write synthetic data elsewhere)');
  process.exit(1);
}
const rng = Rng.fromSeed(20260919);
const DAY = 86_400_000;
const tok = () => Array.from({ length: 22 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[rng.below(62)]).join('');
/** POST with back-off: the API rate-limits writes per client (WRITE_LIMITER), which a bulk seeder hits. */
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  for (;;) {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    const out = { status: r.status, json: await r.json().catch(() => null) };
    if (r.status >= 400) console.warn(`  ${path} → ${r.status} ${out.json?.code ?? ''}`);
    return out;
  }
}

/** "Human-like": mostly corner strategy with mistakes. */
function humanGame(seed: number, skill: number): { moves: string; timing: number[] } {
  const g = new Game(seed);
  const r = Rng.fromSeed(seed ^ 0x5eed);
  const timing: number[] = [];
  const pref: Direction[] = [1, 2, 3, 0];
  while (!g.over && g.moveCount < 3000) {
    const valid = validMoves(g.board);
    const d = r.below(100) < skill ? pref.find((p) => valid.includes(p))! : valid[r.below(valid.length)];
    g.apply(d);
    timing.push(180_000 + r.below(900_000));
  }
  return { moves: g.moves, timing };
}

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
];

let uploads = 0;
const now = Date.now();
const players = Array.from({ length: 28 }, (_, i) => ({ id: tok(), skill: 55 + rng.below(40), firstBack: 5 + rng.below(35), loyalty: rng.below(100), ua: UAS[i % UAS.length] }));
for (const p of players) {
  for (let back = p.firstBack; back >= 0; back--) {
    const active = back === p.firstBack || rng.below(100) < p.loyalty * 0.45;
    if (!active) continue;
    const session = tok();
    await post('/v1/analytics/events', { sessionId: session, first: true, counters: { page_views: 3 + rng.below(8), replay_views: rng.below(3), games_started: 1 + rng.below(3) } }, { 'user-agent': p.ua });
    const games = 1 + rng.below(3);
    let t = now - back * DAY - rng.below(8) * 3_600_000;
    for (let k = 0; k < games; k++) {
      const seed = rng.next();
      const { moves, timing } = humanGame(seed, p.skill);
      const dur = timing.reduce((a, b) => a + b, 0) / 1000;
      const r = await post('/v1/replays', { specVersion: 1, seed, moves, timing, playerKind: 'human', playerId: p.id, sessionId: session, startedAt: Math.round(t), finishedAt: Math.round(t + dur) });
      if (r.status === 201) uploads++;
      t += dur + 30_000;
    }
  }
}
console.log(`uploaded ${uploads} human games from ${players.length} players`);

// Browser AI games (uploaded with search statistics).
for (let i = 0; i < 14; i++) {
  const depth = 1 + (i % 2);
  const agent = new ExpectimaxAgent({ depth });
  const seed = 9000 + i;
  let depthSum = 0;
  const timing: number[] = [];
  const { game } = playSync(agent, seed, { onDecision: (us) => { timing.push(Math.max(1, Math.round(us))); depthSum += depth; } });
  const back = rng.below(20);
  await post('/v1/replays', { specVersion: 1, seed, moves: game.moves, timing, playerKind: 'agent', agent: { name: `expectimax-d${depth} (browser)`, version: '1.0.0', config: { depth } }, playerId: players[i].id, startedAt: now - back * DAY, finishedAt: now - back * DAY + 60_000, stats: { depthSum, depthSamples: timing.length } });
}
console.log('uploaded 14 browser AI games');

// A registered agent playing through the API (pull mode) with metrics.
const reg = await post('/v1/agents', { name: `demo-greedy-${tok().slice(0, 5)}`, kind: 'search', language: 'typescript' });
const key = reg.json.apiKey;
for (let i = 0; i < 6; i++) {
  const g = await post('/v1/games', { seed: 500 + i }, { authorization: `Bearer ${key}` });
  const { game } = playSync(new GreedyAgent(), 500 + i);
  for (let j = 0; j < game.moves.length; j += 200) {
    await post(`/v1/games/${g.json.gameId}/moves`, { moves: game.moves.slice(j, j + 200), timing: Array(Math.min(200, game.moves.length - j)).fill(40), metrics: { depth: 1 } });
  }
}
console.log('played 6 registered-agent games via the API');
