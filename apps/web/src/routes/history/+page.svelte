<script lang="ts">
	import { onMount } from 'svelte';
	import { type LocalGame, allGames, deleteGame } from '$lib/store';
	import Columns from '$lib/charts/Columns.svelte';
	import LineChart from '$lib/charts/LineChart.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import { fmtAgo, fmtInt } from '$lib/format';

	let games = $state<LocalGame[]>([]);
	let filter = $state<'all' | 'human' | 'agent'>('all');
	onMount(async () => (games = (await allGames()).filter((g) => g.moves.length).sort((a, b) => a.startedAt - b.startedAt)));

	const shown = $derived(games.filter((g) => filter === 'all' || g.playerKind === filter));
	const finished = $derived(shown.filter((g) => g.finishedAt));
	const tiles = $derived.by(() => {
		const keys = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
		return keys.map((k) => {
			const n = finished.filter((g) => (k === 64 ? g.maxTile <= 64 : g.maxTile === k)).length;
			return { label: k === 64 ? '≤64' : k >= 1024 ? `${k / 1024}k` : String(k), value: n, note: `${n} games` };
		});
	});
	const scoreSeries = $derived([{ key: filter, label: 'Score', color: 'var(--series-1)', points: finished.map((g, i) => ({ x: i + 1, y: g.score })) }]);
	const reach = (t: number) => (finished.length ? Math.round((finished.filter((g) => g.maxTile >= t).length / finished.length) * 100) + '%' : '-');

	async function remove(id: string) {
		await deleteGame(id);
		games = games.filter((g) => g.id !== id);
	}
</script>

<svelte:head><title>History · 2048 Lab</title></svelte:head>

<div class="flex flex-wrap items-end justify-between gap-3">
	<div>
		<h1 class="text-3xl font-extrabold tracking-tight">Your history</h1>
		<p class="mt-1 text-ink-500">Games stored on this device. Finished games sync to the platform when you're online.</p>
	</div>
	<div class="flex gap-1 rounded-xl bg-ink-900/5 p-1 dark:bg-white/5" role="tablist" aria-label="Filter">
		{#each ['all', 'human', 'agent'] as k (k)}
			<button role="tab" aria-selected={filter === k} class="rounded-lg px-3 py-1.5 text-sm capitalize aria-selected:bg-white aria-selected:font-semibold aria-selected:shadow-sm dark:aria-selected:bg-white/10" onclick={() => (filter = k as typeof filter)}>{k === 'agent' ? 'AI-assisted' : k}</button>
		{/each}
	</div>
</div>

{#if shown.length === 0}
	<p class="mt-10 text-center text-ink-500">No games yet. <a class="underline" href="/play">Start one</a>.</p>
{:else}
	<div class="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
		<Stat label="Games" value={fmtInt(finished.length)} sub="{shown.length - finished.length} in progress" />
		<Stat label="Best" value={fmtInt(Math.max(0, ...finished.map((g) => g.score)))} />
		<Stat label="Average" value={fmtInt(finished.length ? finished.reduce((a, g) => a + g.score, 0) / finished.length : null)} />
		<Stat label="Reached 2048" value={reach(2048)} />
		<Stat label="Reached 4096" value={reach(4096)} />
	</div>
	<div class="mt-4 grid gap-4 lg:grid-cols-2">
		<section class="card p-5" style="background: var(--surface-chart)"><h2 class="mb-3 font-semibold">Max tile per game</h2><Columns title="Max tile distribution" data={tiles} /></section>
		<section class="card p-5" style="background: var(--surface-chart)"><h2 class="mb-3 font-semibold">Score by game</h2><LineChart title="Score by game number" series={scoreSeries} formatY={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} formatX={(x) => `#${x}`} height={180} /></section>
	</div>
	<section class="card mt-4 overflow-hidden">
		<ul>
			{#each [...shown].reverse() as g (g.id)}
				<li class="flex items-center gap-3 border-t border-ink-200/60 px-4 py-2.5 first:border-t-0 dark:border-white/5">
					<a class="mono text-sm hover:underline" href={g.finishedAt ? `/replay/${g.id}` : `/play/${g.id}`}>{g.replayCode}</a>
					<span class="text-sm tabular-nums">{fmtInt(g.score)}</span>
					<span class="hidden text-xs text-ink-500 sm:inline">max {fmtInt(g.maxTile)} · {g.moves.length} moves · {g.playerKind === 'agent' ? g.agent?.name : 'human'}</span>
					<span class="ml-auto text-xs text-ink-400">{g.finishedAt ? fmtAgo(g.finishedAt) : 'in progress'} · {g.sync}</span>
					{#if !g.finishedAt}<a class="btn-ghost py-1 text-xs" href="/play/{g.id}">Resume</a>{/if}
					<button class="text-xs text-ink-400 hover:text-red-600" onclick={() => remove(g.id)} aria-label="Delete game {g.replayCode}">Delete</button>
				</li>
			{/each}
		</ul>
	</section>
{/if}
