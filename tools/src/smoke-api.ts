/**
 * End-to-end API smoke test. Plays real games through the public HTTP API and
 * checks every server answer against the local reference engine.
 *
 *   node tools/src/smoke-api.ts [baseUrl]      (default http://localhost:8787)
 */
import { DIRECTION_NAMES, Game, boardToHex, simulate, validMoves } from '@g2048/engine';
import { RandomAgent } from '@g2048/engine/ai';
import { playSync } from '@g2048/engine/sim';

const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
let failures = 0;

function check(cond: unknown, msg: string): void {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

console.log(`API smoke test against ${BASE}`);

console.log('health');
const h = await call('GET', '/v1/health');
check(h.status === 200 && h.json.ok, 'GET /v1/health');

console.log('pull-mode game played to completion (random agent, batched moves)');
{
  const seed = 1234;
  const created = await call('POST', '/v1/games', { seed, agent: { name: 'smoke-random' } });
  check(created.status === 201, 'POST /v1/games → 201');
  const s = created.json;
  const local = new Game(seed);
  check(s.boardHex === boardToHex(local.board), 'initial board matches reference engine');
  // Play with the reference random agent locally, submitting in batches of 25.
  const { game: ref } = playSync(new RandomAgent(), seed);
  let last: any = s;
  for (let i = 0; i < ref.moves.length; i += 25) {
    const r = await call('POST', `/v1/games/${s.gameId}/moves`, { moves: ref.moves.slice(i, i + 25) });
    if (r.status !== 200) {
      check(false, `batch at ${i} → ${r.status} ${r.text.slice(0, 200)}`);
      break;
    }
    last = r.json;
  }
  check(last.status === 'over', `game over after ${last.moveNumber} moves`);
  check(last.score === ref.score && last.historyHash === ref.historyHash, 'final score + historyHash match reference');
  const after = await call('POST', `/v1/games/${s.gameId}/moves`, { move: 'left' });
  check(after.status === 409 && after.json.code === 'GAME_OVER', 'move after game over → GAME_OVER');
  const rep = await call('GET', `/v1/replays/${s.replayCode}`);
  check(rep.status === 200 && rep.json.moves === ref.moves, 'replay by code returns exact move list');
  check(simulate(rep.json.seed, rep.json.moves).historyHash === rep.json.final.historyHash, 'replay reconstructs locally');
  const byId = await call('GET', `/v1/replays/${s.gameId}`);
  check(byId.status === 200 && byId.json.replayCode === s.replayCode, 'replay by game ID');
  const st = await call('GET', `/v1/games/${s.gameId}`);
  check(st.status === 200 && st.json.status === 'over', 'GET finished game state');
}

console.log('LLM usage reporting');
{
  const g = (await call('POST', '/v1/games', { seed: 4242, agent: { name: 'smoke-llm' } })).json;
  const free = await call('POST', `/v1/games/${g.gameId}/usage`, { model: 'deepseek/deepseek-v4-flash-0731:free', provider: 'openrouter', inputTokens: 5000, outputTokens: 700, calls: 3 });
  check(free.status === 200 && free.json.costUsd === 0 && free.json.tokens.total === 5700, 'free model → $0');
  const exact = await call('POST', `/v1/games/${g.gameId}/usage`, { model: 'some/paid-model', provider: 'openrouter', inputTokens: 9000, outputTokens: 900, costUsd: 0.0123 });
  check(exact.json.costUsd === 0.0123 && exact.json.costEstimated === false, 'client-reported cost kept (re-report replaces)');
  const unknown = await call('POST', `/v1/games/${g.gameId}/usage`, { model: 'mystery-model', inputTokens: 10, outputTokens: 10 });
  check(unknown.json.costUsd === null, 'unknown model without cost → cost unknown, not guessed');
  const nf = await call('POST', '/v1/games/01ARZ3NDEKTSV4RRFFQ69G5FAV/usage', { model: 'x', inputTokens: 1, outputTokens: 1 });
  check(nf.status === 404 && nf.json.code === 'GAME_NOT_FOUND', 'usage for unknown game → GAME_NOT_FOUND');
  const bad = await call('POST', `/v1/games/${g.gameId}/usage`, { inputTokens: 1 });
  check(bad.status === 400 && bad.json.code === 'BAD_REQUEST', 'usage without model → BAD_REQUEST');
  await call('POST', `/v1/games/${g.gameId}/resign`);
}

console.log('errors');
{
  const nf = await call('GET', '/v1/games/01ARZ3NDEKTSV4RRFFQ69G5FAV');
  check(nf.status === 404 && nf.json.error === true && nf.json.code === 'GAME_NOT_FOUND', 'unknown game → GAME_NOT_FOUND');
  // Find a seed whose opening position has an invalid direction.
  let seed = 1;
  while (validMoves(new Game(seed).board).length === 4) seed++;
  const invalid = [0, 1, 2, 3].find((d) => !validMoves(new Game(seed).board).includes(d as 0))!;
  const g = (await call('POST', '/v1/games', { seed })).json;
  const r = await call('POST', `/v1/games/${g.gameId}/moves`, { move: DIRECTION_NAMES[invalid] });
  check(r.status === 422 && r.json.code === 'INVALID_MOVE' && r.json.details?.state?.validMoves, 'invalid move → INVALID_MOVE with state');
  const bad = await call('POST', `/v1/games/${g.gameId}/moves`, { move: 'sideways' });
  check(bad.status === 400 && bad.json.code === 'BAD_REQUEST', 'garbage move → BAD_REQUEST');
  await call('POST', `/v1/games/${g.gameId}/resign`);
}

console.log('replay upload (offline-first path)');
{
  const { game } = playSync(new RandomAgent(), 777);
  const up = await call('POST', '/v1/replays', { specVersion: 1, seed: 777, moves: game.moves, playerKind: 'human', final: { score: game.score } });
  check(up.status === 201 && up.json.final.score === game.score, 'upload verified replay → 201');
  const again = await call('POST', '/v1/replays', { specVersion: 1, gameId: up.json.gameId, seed: 777, moves: game.moves });
  check(again.status === 200, 're-upload is idempotent');
  const forged = await call('POST', '/v1/replays', { specVersion: 1, seed: 777, moves: game.moves, final: { score: game.score + 4 } });
  check(forged.status === 422 && forged.json.code === 'REPLAY_INVALID', 'forged score rejected');
  const short = await call('POST', '/v1/replays', { specVersion: 1, seed: 1, moves: 'LR' });
  check(short.status === 422 && short.json.code === 'NOT_WORTH_STORING', 'tiny games are not stored');
}

console.log('agents');
{
  const name = `smoke-${Date.now().toString(36)}`;
  const reg = await call('POST', '/v1/agents', { name, kind: 'search', language: 'typescript' });
  check(reg.status === 201 && reg.json.apiKey?.startsWith('g2048_'), 'register agent → apiKey');
  const key = reg.json.apiKey;
  const g = await call('POST', '/v1/games', { seed: 99 }, { authorization: `Bearer ${key}` });
  check(g.status === 201 && g.json.player.agentId === reg.json.agent.id, 'game attributed to agent');
  const { game } = playSync(new RandomAgent(), 99);
  const r = await call('POST', `/v1/games/${g.json.gameId}/moves`, { moves: game.moves });
  check(r.json.status === 'over', 'agent game finished in one batch');
  const stats = await call('GET', `/v1/agents/${reg.json.agent.id}`);
  check(stats.json.stats?.gamesPlayed === 1 && stats.json.stats.bestScore === game.score, 'agent stats rolled up');
}

console.log('platform-driven built-in agent');
{
  const g = await call('POST', '/v1/games', { builtin: 'greedy', seed: 3, delayMs: 0 });
  check(g.status === 201 && g.json.player.agentId === 'builtin/greedy', 'start greedy game');
  let st: any = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    st = (await call('GET', `/v1/games/${g.json.gameId}`)).json;
    if (st.status !== 'active') break;
  }
  check(st?.status === 'over' && st.moveNumber > 50, `driver finished the game (${st?.moveNumber} moves, score ${st?.score})`);
}

console.log('spectator WebSocket');
{
  const g = await call('POST', '/v1/games', { builtin: 'greedy', seed: 11, delayMs: 40 });
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/v1/replays/${g.json.replayCode}/live`);
  const msgs: any[] = [];
  await new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      msgs.push(JSON.parse(String(e.data)));
      if (msgs.length >= 5) resolve();
    };
    ws.onerror = () => resolve();
    setTimeout(resolve, 8000);
  });
  ws.close();
  check(msgs[0]?.type === 'hello' && msgs[0].seed === 11, 'hello frame with seed');
  const moves = msgs.filter((m) => m.type === 'moves');
  check(moves.length >= 3, `received ${moves.length} live move frames`);
  // Spectators rebuild the board locally from seed + moves.
  const all = msgs[0].moves + moves.map((m) => m.moves).join('');
  const last = moves[moves.length - 1];
  check(last && simulate(11, all).score === last.score, 'local reconstruction matches streamed score');
}

console.log('benchmarks');
{
  const suites = await call('GET', '/v1/benchmarks/suites');
  check(suites.json.suites?.length >= 3, 'list suites');
  const sess = await call('POST', '/v1/benchmarks/sessions', { agent: 'builtin/greedy', games: 2, seedStart: 1, maxMoves: 300 });
  check(sess.status === 201, 'start server benchmark session');
  let st: any = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    st = (await call('GET', `/v1/benchmarks/sessions/${sess.json.benchmarkId}`)).json;
    if (st.status !== 'running') break;
  }
  check(st?.status === 'complete' && st.gamesCompleted === 2 && st.checksum, `session complete (checksum ${st?.checksum})`);
}

console.log('leaderboard + stats');
{
  const lb = await call('GET', '/v1/leaderboard?kind=all');
  check(lb.status === 200 && Array.isArray(lb.json.topScores), 'leaderboard');
  const s = await call('GET', '/v1/stats');
  check(s.status === 200 && s.json.totals, 'stats');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
