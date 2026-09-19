/**
 * MCP end-to-end test with the official SDK client: discover the server, then
 * play an entire game using only MCP tool calls (as Claude Code/Cursor would).
 *
 *   node tools/src/smoke-mcp.ts [mcpUrl]     (default http://localhost:8788/mcp)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.argv[2] ?? 'http://localhost:8788/mcp';
let failures = 0;
const check = (c: unknown, m: string) => (c ? console.log(`  ok   ${m}`) : (failures++, console.log(`  FAIL ${m}`)));

const client = new Client({ name: 'g2048-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
const info = client.getServerVersion();
check(info?.name === 'g2048', `initialize → ${info?.name} ${info?.version}`);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
for (const t of ['create_game', 'get_game', 'make_move', 'get_replay', 'list_leaderboard', 'get_agent_stats', 'run_benchmark']) check(names.includes(t), `tool ${t} listed`);
check((await client.listPrompts()).prompts.some((p) => p.name === 'play_2048'), 'prompt play_2048 listed');
check((await client.listResources()).resources.some((r) => r.uri === 'g2048://rules'), 'resource g2048://rules listed');

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent ?? JSON.parse(r.content[0].text) };
};

// Play a full game: prefer down/left/right (corner strategy), up only when forced.
let { data: s } = await call('create_game', { seed: 2048, agentName: 'mcp-smoke' });
check(s.gameId && s.status === 'active' && s.board.length === 4, `create_game → ${s.gameId} (${s.replayCode})`);
const order = ['down', 'left', 'right', 'up'];
let calls = 0;
while (s.status === 'active') {
  const move = order.find((m) => s.validMoves.includes(m));
  const r = await call('make_move', { gameId: s.gameId, move });
  if (r.isError) { check(false, `make_move error ${JSON.stringify(r.data).slice(0, 200)}`); break; }
  s = r.data;
  calls++;
}
check(s.status === 'over', `played to completion via ${calls} make_move calls: score ${s.score}, max tile ${s.maxTile}`);

const inv = await call('make_move', { gameId: s.gameId, move: 'left' });
check(inv.isError && inv.data.code === 'GAME_OVER' && inv.data.error === true, 'move after end → {error:true, code:GAME_OVER}');
const nf = await call('get_game', { gameId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
check(nf.isError && nf.data.code === 'GAME_NOT_FOUND', 'unknown game → GAME_NOT_FOUND');

const rep = await call('get_replay', { replayCode: s.replayCode });
check(!rep.isError && rep.data.moves.length === s.moveNumber && rep.data.final.score === s.score, 'get_replay returns full move history');
const lb = await call('list_leaderboard', { kind: 'agent' });
check(!lb.isError && Array.isArray(lb.data.topScores), 'list_leaderboard');
const st = await call('get_agent_stats', { agent: 'builtin/greedy' });
check(!st.isError && st.data.stats, 'get_agent_stats builtin/greedy');
const bench = await call('run_benchmark', { agent: 'builtin/greedy', games: 2, maxMoves: 200, wait: true });
check(!bench.isError && bench.data.status === 'complete' && bench.data.summary, `run_benchmark → ${bench.data.benchmarkId} avgScore ${bench.data.summary?.avgScore}`);

await client.close();
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
