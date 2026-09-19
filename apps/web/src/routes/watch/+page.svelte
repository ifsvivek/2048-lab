<script lang="ts">
	import Skeleton from '$lib/components/Skeleton.svelte';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { ApiUnavailable, api } from '$lib/api';
	import { createLocalGame } from '$lib/newgame';
	import { fmtAgo } from '$lib/format';

	type Live = { replayCode: string; seed: number; source: string; player: { kind: string; name: string | null; agentId: string | null }; startedAt: number };
	let live = $state<Live[] | null>(null);
	let offline = $state(false);
	let starting = $state('');
	let err = $state('');

	async function refresh() {
		try {
			live = (await api<{ live: Live[] }>('/v1/games?limit=30')).live;
			offline = false;
		} catch (e) {
			offline = e instanceof ApiUnavailable;
			live = [];
		}
	}
	onMount(() => {
		refresh();
		const t = setInterval(refresh, 15000);
		return () => clearInterval(t);
	});

	async function watchLocal() {
		const g = await createLocalGame({ playerKind: 'agent', agent: { name: 'expectimax (browser)' } });
		goto(`/play/${g.id}?ai=1`);
	}

	async function startServer(builtin: 'greedy' | 'expectimax') {
		starting = builtin;
		err = '';
		try {
			const s = await api<{ replayCode: string }>('/v1/games', { body: { builtin, delayMs: 120, source: 'web' } });
			goto(`/watch/${s.replayCode}`);
		} catch (e) {
			err = (e as Error).message;
		} finally {
			starting = '';
		}
	}
</script>

<svelte:head><title>Watch AI · 2048 Lab</title></svelte:head>

<h1 class="text-3xl font-extrabold tracking-tight">Watch AI play</h1>
<p class="mt-1 text-ink-500">Spectate built-in agents, external agents playing through the API or MCP, and benchmark runs in real time.</p>

<div class="mt-6 grid gap-4 md:grid-cols-3">
	<button class="card p-5 text-left transition hover:-translate-y-0.5" onclick={watchLocal}>
		<p class="label">In your browser</p>
		<p class="mt-1 text-lg font-bold">Expectimax, full strength</p>
		<p class="mt-1 text-sm text-ink-500">Canonical search (depth 2-4) in a Web Worker, with live reasoning. Works offline.</p>
	</button>
	<button class="card p-5 text-left transition hover:-translate-y-0.5 disabled:opacity-60" onclick={() => startServer('expectimax')} disabled={!!starting || offline}>
		<p class="label">On the platform</p>
		<p class="mt-1 text-lg font-bold">{starting === 'expectimax' ? 'Starting…' : 'Server expectimax (depth 2)'}</p>
		<p class="mt-1 text-sm text-ink-500">Runs inside a Durable Object; anyone can watch with the replay code.</p>
	</button>
	<button class="card p-5 text-left transition hover:-translate-y-0.5 disabled:opacity-60" onclick={() => startServer('greedy')} disabled={!!starting || offline}>
		<p class="label">On the platform</p>
		<p class="mt-1 text-lg font-bold">{starting === 'greedy' ? 'Starting…' : 'Server greedy'}</p>
		<p class="mt-1 text-sm text-ink-500">A one-ply baseline: fast, and a useful yardstick.</p>
	</button>
</div>
{#if err}<p class="mt-3 text-sm text-red-600" role="alert">{err}</p>{/if}

<div class="mt-10 flex items-center justify-between">
	<h2 class="text-lg font-bold">Live now</h2>
	<button class="btn-ghost py-1.5 text-xs" onclick={refresh}>Refresh</button>
</div>
{#if offline}
	<p class="mt-3 text-sm text-ink-500">You're offline. Live games need the network, but the in-browser AI still works.</p>
{:else if live === null}
	<Skeleton rows={3} class="mt-3" />
{:else if live.length === 0}
	<p class="mt-3 text-sm text-ink-500">No live games right now. Start one above, or connect an agent from the <a class="underline" href="/agents">Agents</a> page.</p>
{:else}
	<ul class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
		{#each live as g (g.replayCode)}
			<li>
				<a href="/watch/{g.replayCode}" class="card flex items-center gap-3 p-3 hover:bg-white dark:hover:bg-white/[0.06]">
					<span class="h-2 w-2 rounded-full bg-red-500" aria-hidden="true"></span>
					<div class="min-w-0">
						<div class="truncate font-semibold">{g.player.name ?? (g.player.kind === 'human' ? 'Human (API)' : 'Agent')}</div>
						<div class="mono text-xs text-ink-500">{g.replayCode} · via {g.source} · {fmtAgo(g.startedAt)}</div>
					</div>
				</a>
			</li>
		{/each}
	</ul>
{/if}
