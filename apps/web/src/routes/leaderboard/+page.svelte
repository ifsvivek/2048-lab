<script lang="ts">
	import Skeleton from '$lib/components/Skeleton.svelte';
	import { onMount } from 'svelte';
	import { ApiUnavailable, api } from '$lib/api';
	import { getMeta, setMeta } from '$lib/store';
	import { fmtAgo, fmtInt } from '$lib/format';

	let kind = $state<'all' | 'human' | 'agent'>('all');
	let data = $state<any>(null);
	let offline = $state(false);

	async function load() {
		const key = `leaderboard:${kind}`;
		try {
			const fresh = await api(`/v1/leaderboard?kind=${kind}&limit=50`);
			data = fresh;
			setMeta(key, fresh); // keep last copy for offline viewing (raw object, not the state proxy)
			offline = false;
		} catch (e) {
			offline = e instanceof ApiUnavailable;
			data = (await getMeta(key)) ?? { topScores: [], topAgents: [] };
		}
	}
	onMount(load);
</script>

<svelte:head><title>Leaderboard · 2048 Lab</title></svelte:head>

<div class="flex flex-wrap items-end justify-between gap-3">
	<h1 class="text-3xl font-extrabold tracking-tight">Leaderboard</h1>
	<div class="flex gap-1 rounded-xl bg-ink-900/5 p-1 dark:bg-white/5" role="tablist" aria-label="Player type">
		{#each ['all', 'human', 'agent'] as k (k)}
			<button role="tab" aria-selected={kind === k} class="rounded-lg px-3 py-1.5 text-sm capitalize aria-selected:bg-white aria-selected:font-semibold aria-selected:shadow-sm dark:aria-selected:bg-white/10" onclick={() => { kind = k as typeof kind; load(); }}>{k === 'all' ? 'Everyone' : k === 'human' ? 'Humans' : 'Agents'}</button>
		{/each}
	</div>
</div>
{#if offline}<p class="mt-2 text-sm text-ink-500">Offline. Showing the last copy you loaded.</p>{/if}
<p class="mt-1 text-sm text-ink-500">Every score is verified by re-simulating the game on the server. Click a row to watch the replay.</p>

<div class="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
	<section class="card overflow-hidden">
		<h2 class="px-4 pt-4 font-semibold">Top scores</h2>
		{#if !data}
			<Skeleton rows={6} class="p-4" />
		{:else if data.topScores.length === 0}
			<p class="p-4 text-sm text-ink-500">No games yet. <a class="underline" href="/play">be the first</a>.</p>
		{:else}
			<ol class="mt-2">
				{#each data.topScores as g (g.replayCode)}
					<li>
						<a href="/replay/{g.replayCode}" class="grid grid-cols-[2rem_1fr_auto] items-center gap-3 border-t border-ink-200/60 px-4 py-2.5 hover:bg-ink-900/[0.03] dark:border-white/5 dark:hover:bg-white/[0.03]">
							<span class="text-right font-bold text-ink-400 tabular-nums">{g.rank}</span>
							<span class="min-w-0">
								<span class="block truncate font-medium">{g.player.name ?? (g.player.kind === 'human' ? 'Human' : 'Agent')}</span>
								<span class="mono text-xs text-ink-500">{g.replayCode} · max {fmtInt(g.maxTile)} · {fmtInt(g.moveCount)} moves · {fmtAgo(g.finishedAt)}</span>
							</span>
							<span class="text-lg font-bold tabular-nums">{fmtInt(g.score)}</span>
						</a>
					</li>
				{/each}
			</ol>
		{/if}
	</section>
	<section class="card overflow-hidden">
		<h2 class="px-4 pt-4 font-semibold">Top agents</h2>
		{#if data?.topAgents?.length}
			<ol class="mt-2">
				{#each data.topAgents as a (a.id)}
					<li class="grid grid-cols-[2rem_1fr_auto] items-center gap-3 border-t border-ink-200/60 px-4 py-2.5 dark:border-white/5">
						<span class="text-right font-bold text-ink-400">{a.rank}</span>
						<span><span class="font-medium">{a.name}</span><span class="block text-xs text-ink-500">{a.stats.gamesPlayed} games · avg {fmtInt(a.stats.avgScore)} · {a.language ?? a.kind}</span></span>
						<span class="font-bold tabular-nums">{fmtInt(a.stats.bestScore)}</span>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="p-4 text-sm text-ink-500">No registered agents have finished games yet.</p>
		{/if}
	</section>
</div>
