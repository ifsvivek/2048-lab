<script lang="ts">
	import { goto } from '$app/navigation';
	import { classifyGameRef, Game } from '@g2048/engine';
	import { onMount } from 'svelte';
	import Board from '$lib/components/Board.svelte';
	import { createLocalGame } from '$lib/newgame';

	let ref = $state('');
	let refError = $state('');
	let starting = $state(false);

	async function start() {
		starting = true;
		const g = await createLocalGame();
		await goto(`/play/${g.id}`);
	}

	function openReplay(e: SubmitEvent) {
		e.preventDefault();
		const c = classifyGameRef(ref);
		if (!c) {
			refError = 'Enter a replay code like A7KF-29LM-XQ4P or a 26-character game ID.';
			return;
		}
		goto(`/replay/${encodeURIComponent(c.value)}`);
	}

	// Ambient demo board: a deterministic game playing itself.
	let demo = new Game(20480);
	let board = $state(new Game(20480).board.slice());
	onMount(() => {
		const order = [1, 2, 3, 2, 1, 2, 0] as const;
		let k = 0;
		const t = setInterval(() => {
			if (demo.over || demo.moveCount > 400) {
				demo = new Game((demo.seed + 1) >>> 0);
			} else {
				for (let i = 0; i < 4 && !demo.apply(order[k++ % order.length]); i++);
			}
			board = demo.board.slice();
		}, 650);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>2048 Lab — play, watch & benchmark AI</title></svelte:head>

<section class="grid items-center gap-10 pt-4 md:grid-cols-[1.1fr_1fr] md:pt-10">
	<div>
		<p class="label mb-3">Deterministic 2048 · research platform</p>
		<h1 class="text-4xl leading-[1.05] font-extrabold tracking-tight text-balance md:text-6xl">
			Play it. Replay it.<br /><span class="text-accent-600 dark:text-accent-400">Benchmark it.</span>
		</h1>
		<p class="mt-4 max-w-md text-ink-600 dark:text-ink-300">
			Every game is reproducible from its seed and move list — identically in TypeScript, Rust, Go and Python.
		</p>

		<div class="mt-8 grid max-w-md gap-3">
			<button class="btn-primary h-14 text-base" onclick={start} disabled={starting}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
				Start New Game
			</button>
			<form class="card flex gap-2 p-2" onsubmit={openReplay}>
				<label for="ref" class="sr-only">Replay code or game ID</label>
				<input
					id="ref"
					class="min-w-0 flex-1 bg-transparent px-3 font-mono text-sm tracking-wider uppercase outline-none placeholder:tracking-normal placeholder:normal-case"
					placeholder="Replay code, e.g. A7KF-29LM-XQ4P"
					bind:value={ref}
					oninput={() => (refError = '')}
					autocomplete="off"
					spellcheck="false"
					aria-describedby={refError ? 'ref-err' : undefined}
				/>
				<button class="btn-ghost h-11 shrink-0" type="submit">Open Replay</button>
			</form>
			{#if refError}<p id="ref-err" class="text-sm text-red-600 dark:text-red-400" role="alert">{refError}</p>{/if}
		</div>

		<div class="mt-10 flex flex-wrap gap-x-5 gap-y-2 text-sm">
			<a class="text-ink-600 underline-offset-4 hover:underline dark:text-ink-300" href="/watch">Watch the AI play →</a>
			<a class="text-ink-600 underline-offset-4 hover:underline dark:text-ink-300" href="/runtimes">Compare runtimes →</a>
			<a class="text-ink-600 underline-offset-4 hover:underline dark:text-ink-300" href="/agents">Connect your agent (API / MCP) →</a>
		</div>
	</div>

	<div class="mx-auto w-full max-w-sm md:max-w-md" aria-hidden="true">
		<div class="rotate-[-2deg] rounded-[28px] bg-white p-3 shadow-2xl shadow-ink-900/10 dark:bg-ink-900 dark:shadow-black/40">
			<Board {board} animate={false} label="Demo board" />
		</div>
	</div>
</section>
