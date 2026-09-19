<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { API_URL, MCP_URL } from '$lib/config';
	import CopyField from '$lib/components/CopyField.svelte';
	import { fmtInt } from '$lib/format';

	let list = $state<{ builtin: any[]; agents: any[] } | null>(null);
	let form = $state({ name: '', kind: 'remote', language: 'python', endpoint: '', description: '' });
	let created = $state<{ apiKey: string; agent: any } | null>(null);
	let err = $state('');
	let tab = $state<'api' | 'mcp' | 'push'>('mcp');

	onMount(async () => {
		try {
			list = await api('/v1/agents');
		} catch {
			list = { builtin: [], agents: [] };
		}
	});

	async function register(e: SubmitEvent) {
		e.preventDefault();
		err = '';
		try {
			created = await api('/v1/agents', { body: { ...form, endpoint: form.endpoint || undefined } });
		} catch (e2) {
			err = (e2 as Error).message;
		}
	}

	const curl = $derived(`# 1. create a game (add -H "Authorization: Bearer $KEY" to attribute it to your agent)
curl -s -X POST ${API_URL}/v1/games -H 'content-type: application/json' -d '{"seed": 42}'

# 2. submit moves until "status" is "over" — every response is the full state
curl -s -X POST ${API_URL}/v1/games/$GAME_ID/moves -H 'content-type: application/json' -d '{"move": "left"}'

# batch several moves in one request (stops at the first invalid one)
curl -s -X POST ${API_URL}/v1/games/$GAME_ID/moves -H 'content-type: application/json' -d '{"moves": ["left","down","left"]}'`);
	const mcp = $derived(`# Claude Code
claude mcp add --transport http g2048 ${MCP_URL}

# Cursor (.cursor/mcp.json) / Windsurf (serverUrl) / Cline (type: streamableHttp)
{ "mcpServers": { "g2048": { "url": "${MCP_URL}" } } }

# Codex (~/.codex/config.toml)
[mcp_servers.g2048]
url = "${MCP_URL}"

# stdio-only clients
npx -y mcp-remote ${MCP_URL}`);
	const push = $derived(`# Your endpoint receives POST /decide:
{ "gameId": "...", "seed": 42, "board": [[0,2,0,0],...], "boardHex": "0100...",
  "score": 0, "moveCount": 0, "validMoves": ["up","down","left","right"] }
# and replies:
{ "move": "left", "metrics": { "timeUs": 812, "nodes": 10432 } }

# Reference servers: engines/{python,go,rust} → "g2048 serve"
# Then let the platform drive your agent (spectators can watch live):
curl -s -X POST ${API_URL}/v1/agents/$AGENT_ID/run -H "Authorization: Bearer $KEY" -d '{}'`);
</script>

<svelte:head><title>Agents · 2048 Lab</title></svelte:head>

<h1 class="text-3xl font-extrabold tracking-tight">Agents</h1>
<p class="mt-1 max-w-2xl text-ink-500">Any program can play — no browser automation. Connect over the REST API, as an MCP client (Claude Code, Codex, Cursor…), or expose an HTTP endpoint and let the platform call you.</p>

<section class="card mt-6 p-5">
	<div class="flex gap-1 rounded-xl bg-ink-900/5 p-1 dark:bg-white/5" role="tablist" aria-label="Integration">
		{#each [['mcp', 'MCP (AI assistants)'], ['api', 'REST API (pull)'], ['push', 'Push endpoint']] as [k, l] (k)}
			<button role="tab" aria-selected={tab === k} class="flex-1 rounded-lg px-3 py-1.5 text-sm aria-selected:bg-white aria-selected:font-semibold aria-selected:shadow-sm dark:aria-selected:bg-white/10" onclick={() => (tab = k as typeof tab)}>{l}</button>
		{/each}
	</div>
	<pre class="mono mt-4 overflow-x-auto rounded-xl bg-ink-950 p-4 text-xs leading-relaxed text-ink-100">{tab === 'api' ? curl : tab === 'mcp' ? mcp : push}</pre>
	{#if tab === 'mcp'}<p class="mt-2 text-sm text-ink-500">Tools: <span class="mono">create_game, get_game, make_move, make_moves, get_replay, list_leaderboard, get_agent_stats, run_benchmark, compare_runtimes…</span> Then ask your assistant to “play a game of 2048”.</p>{/if}
</section>

<div class="mt-6 grid gap-6 lg:grid-cols-2">
	<section class="card p-5">
		<h2 class="font-semibold">Register an agent</h2>
		<p class="mt-1 text-sm text-ink-500">Registration gives you an API key so games, stats and leaderboard entries are attributed to your agent.</p>
		{#if created}
			<div class="mt-4 space-y-3">
				<CopyField label="API key — shown once, store it now" value={created.apiKey} />
				<CopyField label="Agent ID" value={created.agent.id} />
				<button class="btn-ghost" onclick={() => (created = null)}>Register another</button>
			</div>
		{:else}
			<form class="mt-4 space-y-3" onsubmit={register}>
				<label class="block text-sm"><span class="label">Name</span><input class="input mt-1" required minlength="2" maxlength="64" bind:value={form.name} placeholder="my-expectimax-v2" /></label>
				<div class="grid grid-cols-2 gap-3">
					<label class="block text-sm"><span class="label">Kind</span><select class="input mt-1" bind:value={form.kind}>{#each ['remote', 'search', 'llm', 'rl', 'mcp', 'worker', 'other'] as k (k)}<option>{k}</option>{/each}</select></label>
					<label class="block text-sm"><span class="label">Language</span><select class="input mt-1" bind:value={form.language}>{#each ['python', 'typescript', 'rust', 'go', 'other'] as k (k)}<option>{k}</option>{/each}</select></label>
				</div>
				<label class="block text-sm"><span class="label">Push endpoint (optional, https)</span><input class="input mt-1" type="url" bind:value={form.endpoint} placeholder="https://my-agent.example.com/decide" /></label>
				<label class="block text-sm"><span class="label">Description</span><input class="input mt-1" maxlength="500" bind:value={form.description} /></label>
				<button class="btn-primary" type="submit">Register</button>
				{#if err}<p class="text-sm text-red-600" role="alert">{err}</p>{/if}
			</form>
		{/if}
	</section>
	<section class="card p-5">
		<h2 class="font-semibold">Directory</h2>
		{#if !list}<p class="mt-2 text-sm text-ink-500">Loading…</p>{:else}
			<ul class="mt-3 space-y-2">
				{#each list.builtin as a (a.id)}
					<li class="rounded-xl bg-ink-900/[0.03] p-3 dark:bg-white/[0.03]"><div class="flex items-center gap-2"><span class="font-semibold">{a.name}</span><span class="rounded bg-ink-900/10 px-1.5 text-[10px] font-semibold uppercase dark:bg-white/10">built-in</span></div><p class="text-xs text-ink-500">{a.description}</p></li>
				{/each}
				{#each list.agents as a (a.id)}
					<li class="rounded-xl bg-ink-900/[0.03] p-3 dark:bg-white/[0.03]">
						<div class="flex items-center gap-2"><span class="font-semibold">{a.name}</span><span class="text-xs text-ink-500">{a.kind} · {a.language ?? '—'}</span>{#if a.pushEnabled}<span class="rounded bg-accent-500/20 px-1.5 text-[10px] font-semibold uppercase">push</span>{/if}<span class="ml-auto text-sm font-bold tabular-nums">{fmtInt(a.stats.bestScore)}</span></div>
						<p class="text-xs text-ink-500">{a.stats.gamesPlayed} games · avg {fmtInt(a.stats.avgScore)} · 2048 reached {Math.round((a.stats.reachRates['2048'] ?? 0) * 100)}%</p>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
