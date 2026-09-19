<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { type Direction, DIRECTION_NAMES, Game, boardToHex, maxTile, simulate } from '@g2048/engine';
	import type { DecisionMetrics } from '@g2048/engine/ai';
	import { onDestroy, onMount } from 'svelte';
	import Board, { type BoardStep } from '$lib/components/Board.svelte';
	import CopyField from '$lib/components/CopyField.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import AiPanel from '$lib/components/AiPanel.svelte';
	import { AiWorker } from '$lib/ai/client';
	import { createLocalGame } from '$lib/newgame';
	import { type LocalGame, getGame, getMeta, saveGame, setMeta } from '$lib/store';
	import { uploadGame } from '$lib/sync';
	import { KEY_DIR, swipe } from '$lib/swipe';
	import { fmtInt, fmtUs } from '$lib/format';

	let record = $state<LocalGame | null>(null);
	let game: Game | null = null;
	let board = $state<Uint8Array>(new Uint8Array(16));
	let step = $state<BoardStep | null>(null);
	let score = $state(0);
	let moveCount = $state(0);
	let over = $state(false);
	let best = $state(0);
	let notFound = $state(false);
	let announce = $state('');

	// AI
	let ai: AiWorker | null = null;
	let aiOn = $state(false);
	let aiAgent = $state<'expectimax' | 'greedy' | 'random'>('expectimax');
	let aiDepth = $state<'auto' | 1 | 2 | 3>('auto');
	let aiDelay = $state(120);
	let lastMetrics = $state<DecisionMetrics | null>(null);
	let lastAiMove = $state<Direction | null>(null);
	let hint = $state<Direction | null>(null);
	let aiUsed = false;
	let thinking = false;
	let lastInputAt = performance.now();

	const aiConfig = () => (aiAgent === 'expectimax' ? (aiDepth === 'auto' ? {} : { depth: aiDepth }) : {});

	async function load(id: string) {
		const r = await getGame(id);
		if (!r) {
			notFound = true;
			return;
		}
		record = r;
		game = simulate(r.seed, r.moves);
		board = game.board.slice();
		score = game.score;
		moveCount = game.moveCount;
		over = game.over;
		aiUsed = r.playerKind === 'agent';
		best = (await getMeta<number>('best')) ?? 0;
	}

	async function persist(finished: boolean) {
		if (!record || !game) return;
		record = {
			...record,
			moves: game.moves,
			score: game.score,
			maxTile: maxTile(game.board),
			over: game.over,
			finishedAt: finished ? Date.now() : null,
			playerKind: aiUsed ? 'agent' : 'human',
			agent: aiUsed ? { name: `${aiAgent} (browser)`, version: '1.0.0', config: aiConfig() } : undefined
		};
		await saveGame($state.snapshot(record) as LocalGame);
		if (game.score > best) {
			best = game.score;
			setMeta('best', best);
		}
		if (finished) record = await uploadGame($state.snapshot(record) as LocalGame);
	}

	function play(dir: Direction, timeUs?: number) {
		if (!game || over || !record) return false;
		const prev = game.board.slice();
		const res = game.apply(dir);
		if (!res) return false;
		const t = timeUs ?? Math.round((performance.now() - lastInputAt) * 1000);
		lastInputAt = performance.now();
		record.timing = [...record.timing, t];
		step = { prev, dir, spawn: res.spawn };
		board = game.board.slice();
		score = game.score;
		moveCount = game.moveCount;
		over = game.over;
		hint = null;
		if (res.gained >= 2048) announce = `Merged ${res.gained}!`;
		if (over) announce = `Game over. Final score ${game.score}.`;
		persist(over);
		return true;
	}

	function onKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
		const d = KEY_DIR[e.key];
		if (d !== undefined) {
			e.preventDefault();
			if (!aiOn) play(d);
		} else if (e.key === ' ' && !over) {
			e.preventDefault();
			toggleAi();
		}
	}

	async function aiStep(): Promise<void> {
		if (!aiOn || !game || over || thinking) return;
		thinking = true;
		try {
			ai ??= new AiWorker();
			const d = await ai.decide({ boardHex: boardToHex(game.board), seed: game.seed, score: game.score, moveCount: game.moveCount, agent: aiAgent, config: aiConfig() });
			lastMetrics = d.metrics;
			lastAiMove = d.move;
			if (!aiOn) return;
			aiUsed = true;
			if (record && d.metrics.depth) {
				const s = record.aiStats ?? { depthSum: 0, depthSamples: 0 };
				record.aiStats = { depthSum: s.depthSum + d.metrics.depth, depthSamples: s.depthSamples + 1 };
			}
			play(d.move, d.metrics.timeUs);
		} finally {
			thinking = false;
		}
		if (aiOn && !over) setTimeout(aiStep, aiDelay);
		else aiOn = false;
	}

	function toggleAi() {
		aiOn = !aiOn;
		if (aiOn) aiStep();
	}

	async function getHint() {
		if (!game || over) return;
		ai ??= new AiWorker();
		const d = await ai.decide({ boardHex: boardToHex(game.board), seed: game.seed, score: game.score, moveCount: game.moveCount, agent: 'expectimax', config: {} });
		hint = d.move;
		lastMetrics = d.metrics;
		lastAiMove = d.move;
	}

	async function newGame(sameSeed = false) {
		aiOn = false;
		const g = await createLocalGame({ seed: sameSeed && record ? record.seed : undefined });
		step = null;
		await goto(`/play/${g.id}`);
	}

	$effect(() => {
		const id = page.params.id;
		if (id) {
			aiOn = false;
			step = null;
			load(id);
		}
	});

	onMount(() => {
		if (page.url.searchParams.get('ai')) setTimeout(() => !aiOn && toggleAi(), 400);
	});
	onDestroy(() => {
		aiOn = false;
		ai?.terminate();
	});

	const shareUrl = $derived(record ? `${location.origin}/replay/${record.replayCode}` : '');
	const syncLabel = $derived(
		!record ? '' : record.sync === 'synced' ? 'Replay saved — anyone with the code can watch it' : record.sync === 'pending' ? 'Offline — will upload when you reconnect' : record.sync === 'skipped' ? 'Short game — kept on this device only' : record.finishedAt ? 'Saving…' : 'Replay is shareable once the game ends'
	);
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>Play · 2048 Lab</title></svelte:head>

{#if notFound}
	<div class="py-20 text-center">
		<p class="text-lg font-semibold">This game isn't on this device.</p>
		<p class="mt-1 text-ink-500">Local games live in your browser. To watch someone else's game, open its replay code.</p>
		<div class="mt-6 flex justify-center gap-3"><a href="/replay/{page.params.id}" class="btn-ghost">Look up replay</a><button class="btn-primary" onclick={() => newGame()}>New game</button></div>
	</div>
{:else if record}
	<div class="grid gap-6 lg:grid-cols-[minmax(0,34rem)_1fr]">
		<div>
			<div class="mb-3 grid grid-cols-3 gap-2">
				<Stat label="Score" value={fmtInt(score)} />
				<Stat label="Best" value={fmtInt(Math.max(best, score))} />
				<Stat label="Moves" value={fmtInt(moveCount)} />
			</div>

			<div class="relative rounded-[22px]" use:swipe={(d) => !aiOn && play(d)}>
				<Board {board} {step} label="2048 board, score {score}" overlay={over ? gameOver : undefined} />
				{#snippet gameOver()}
					<div class="flex h-full w-full flex-col items-center justify-center bg-ink-50/85 p-6 text-center backdrop-blur-sm dark:bg-ink-950/80" role="dialog" aria-label="Game over">
						<p class="label">Game over</p>
						<p class="mt-1 text-5xl font-extrabold tracking-tight tabular-nums">{fmtInt(score)}</p>
						<p class="mt-1 text-sm text-ink-500">max tile {maxTile(board).toLocaleString()} · {moveCount} moves</p>
						<div class="mt-5 flex flex-wrap justify-center gap-2">
							<button class="btn-primary" onclick={() => newGame()}>New game</button>
							<a class="btn-ghost" href="/replay/{record?.replayCode}">Watch replay</a>
							<button class="btn-ghost" onclick={() => newGame(true)}>Retry this seed</button>
						</div>
					</div>
				{/snippet}
				{#if hint !== null}
					<div class="pointer-events-none absolute inset-x-0 -bottom-3 z-10 flex justify-center">
						<span class="rounded-full bg-ink-900 px-3 py-1 text-xs font-semibold text-white shadow dark:bg-accent-500 dark:text-ink-950">Hint: {DIRECTION_NAMES[hint]}</span>
					</div>
				{/if}
			</div>

			<div class="mt-4 flex flex-wrap items-center gap-2">
				<button class="btn-primary" onclick={toggleAi} disabled={over} aria-pressed={aiOn}>
					{aiOn ? 'Stop AI' : 'Let AI play'}
				</button>
				<button class="btn-ghost" onclick={getHint} disabled={over || aiOn}>Hint</button>
				<button class="btn-ghost" onclick={() => newGame()}>New game</button>
				<span class="ml-auto hidden text-xs text-ink-500 sm:block">Arrows / WASD / swipe · Space toggles AI</span>
			</div>
			<p class="sr-only" aria-live="polite">{announce}</p>
		</div>

		<div class="space-y-4">
			<section class="card p-4" aria-labelledby="ids-h">
				<h2 id="ids-h" class="mb-3 text-sm font-semibold">Share this game</h2>
				<div class="grid grid-cols-2 gap-3">
					<CopyField label="Replay code" value={record.replayCode} href={shareUrl} />
					<CopyField label="Seed" value={String(record.seed)} />
					<div class="col-span-2"><CopyField label="Game ID" value={record.id} /></div>
				</div>
				<p class="mt-3 text-xs text-ink-500 dark:text-ink-400">{syncLabel}. The seed alone lets anyone replay the exact same tile sequence (<a class="underline" href="/play?seed={record.seed}">play seed {record.seed}</a>).</p>
			</section>

			<section class="card p-4" aria-labelledby="ai-h">
				<div class="mb-3 flex items-center justify-between">
					<h2 id="ai-h" class="text-sm font-semibold">Built-in AI</h2>
					<span class="text-xs text-ink-500">runs locally in a Web Worker</span>
				</div>
				<div class="grid grid-cols-3 gap-2">
					<label class="text-xs"><span class="label">Agent</span>
						<select class="input mt-1 py-1.5" bind:value={aiAgent}>
							<option value="expectimax">Expectimax</option><option value="greedy">Greedy</option><option value="random">Random</option>
						</select>
					</label>
					<label class="text-xs"><span class="label">Depth</span>
						<select class="input mt-1 py-1.5" bind:value={aiDepth} disabled={aiAgent !== 'expectimax'}>
							<option value="auto">Auto (2–4)</option><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
						</select>
					</label>
					<label class="text-xs"><span class="label">Delay {aiDelay} ms</span>
						<input class="mt-3 w-full accent-accent-500" type="range" min="0" max="600" step="20" bind:value={aiDelay} />
					</label>
				</div>
				<AiPanel metrics={lastMetrics} move={lastAiMove} />
				{#if lastMetrics}<p class="mt-2 text-xs text-ink-500">Decision latency {fmtUs(lastMetrics.timeUs)}</p>{/if}
			</section>
		</div>
	</div>
{/if}
