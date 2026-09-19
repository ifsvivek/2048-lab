<script lang="ts">
	import { goto } from '$app/navigation';
	import { classifyGameRef } from '@g2048/engine';
	import { onMount } from 'svelte';
	import { allCachedReplays, type CachedReplay, type LocalGame } from '$lib/store';
	import { localReplayList } from '$lib/replays';
	import { fmtAgo, fmtInt } from '$lib/format';

	let ref = $state('');
	let err = $state('');
	let local = $state<LocalGame[]>([]);
	let cached = $state<CachedReplay[]>([]);

	onMount(async () => {
		local = (await localReplayList()).slice(0, 12);
		cached = (await allCachedReplays()).sort((a, b) => b.cachedAt - a.cachedAt).slice(0, 12);
	});

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const c = classifyGameRef(ref);
		if (!c) return (err = 'Enter a replay code (A7KF-29LM-XQ4P) or a game ID.');
		goto(`/replay/${encodeURIComponent(c.value)}`);
	}
</script>

<svelte:head><title>Open replay · 2048 Lab</title></svelte:head>

<div class="mx-auto max-w-xl pt-6">
	<h1 class="text-3xl font-extrabold tracking-tight">Open a replay</h1>
	<p class="mt-1 text-ink-500">Every game is rebuilt move-by-move from its seed — the result is bit-for-bit what was played.</p>
	<form class="card mt-6 flex gap-2 p-2" onsubmit={submit}>
		<label for="r" class="sr-only">Replay code or game ID</label>
		<input id="r" class="min-w-0 flex-1 bg-transparent px-3 font-mono tracking-wider uppercase outline-none placeholder:tracking-normal placeholder:normal-case" placeholder="A7KF-29LM-XQ4P or game ID" bind:value={ref} oninput={() => (err = '')} autocomplete="off" spellcheck="false" />
		<button class="btn-primary" type="submit">Open</button>
	</form>
	{#if err}<p class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{err}</p>{/if}

	{#if local.length}
		<h2 class="label mt-10 mb-2">Your games on this device</h2>
		<ul class="card divide-y divide-ink-200/60 dark:divide-white/5">
			{#each local as g (g.id)}
				<li><a class="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-900/[0.03] dark:hover:bg-white/[0.03]" href="/replay/{g.id}">
					<span class="mono text-sm">{g.replayCode}</span>
					<span class="text-sm text-ink-500">{fmtInt(g.score)} pts · {g.moves.length} moves</span>
					<span class="ml-auto text-xs text-ink-400">{g.finishedAt ? fmtAgo(g.finishedAt) : 'in progress'}</span>
				</a></li>
			{/each}
		</ul>
	{/if}
	{#if cached.length}
		<h2 class="label mt-8 mb-2">Recently watched (available offline)</h2>
		<ul class="card divide-y divide-ink-200/60 dark:divide-white/5">
			{#each cached as r (r.replayCode)}
				<li><a class="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-900/[0.03] dark:hover:bg-white/[0.03]" href="/replay/{r.replayCode}">
					<span class="mono text-sm">{r.replayCode}</span>
					<span class="text-sm text-ink-500">{fmtInt(r.final.score)} pts · {r.agent?.name ?? r.playerKind}</span>
				</a></li>
			{/each}
		</ul>
	{/if}
</div>
