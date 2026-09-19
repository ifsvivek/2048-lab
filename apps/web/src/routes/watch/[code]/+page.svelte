<script lang="ts">
	import { page } from '$app/state';
	import { type Direction, Game, maxTile } from '@g2048/engine';
	import { onDestroy } from 'svelte';
	import Board, { type BoardStep } from '$lib/components/Board.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import { wsUrl } from '$lib/api';
	import { fmtInt, fmtUs, fmtCompact } from '$lib/format';

	/**
	 * Spectating is bandwidth-light: the server streams only move letters, and
	 * the board is rebuilt locally with the deterministic engine from the seed.
	 */
	let game: Game | null = null;
	let board = $state(new Uint8Array(16));
	let step = $state<BoardStep | null>(null);
	let score = $state(0);
	let moves = $state(0);
	let status = $state<'connecting' | 'live' | 'ended' | 'error'>('connecting');
	let endStatus = $state('');
	let player = $state<{ name?: string | null; kind: string } | null>(null);
	let spectators = $state(0);
	let metrics = $state<Record<string, number> | null>(null);
	let latency = $state<number[]>([]);
	let message = $state('');
	let ws: WebSocket | null = null;
	let queue: string[] = [];
	let drain: ReturnType<typeof setInterval> | undefined;

	function applyLetters(letters: string, animateLast: boolean) {
		if (!game) return;
		for (let i = 0; i < letters.length; i++) {
			const prev = game.board.slice();
			const dir = 'UDLR'.indexOf(letters[i]) as Direction;
			const r = game.apply(dir);
			if (r && animateLast && i === letters.length - 1) step = { prev, dir, spawn: r.spawn };
		}
		board = game.board.slice();
		score = game.score;
		moves = game.moveCount;
	}

	function connect(code: string) {
		ws?.close();
		status = 'connecting';
		ws = new WebSocket(wsUrl(`/v1/replays/${code}/live`));
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data);
			if (m.type === 'hello') {
				game = new Game(m.seed);
				step = null;
				applyLetters(m.moves, false);
				player = m.state.player;
				spectators = m.spectators;
				status = 'live';
			} else if (m.type === 'moves') {
				queue.push(...m.moves); // smooth bursts into a steady animation
				if (m.metrics) {
					metrics = m.metrics;
					if (typeof m.metrics.timeUs === 'number') latency = [...latency.slice(-59), m.metrics.timeUs];
				}
			} else if (m.type === 'end') {
				endStatus = m.status;
			} else if (m.type === 'error') message = m.message;
		};
		ws.onclose = () => {
			if (status !== 'error') status = 'ended';
		};
		ws.onerror = () => {
			status = 'error';
			message = 'This game is not live (it may have finished). Try the replay instead.';
		};
	}

	$effect(() => {
		const code = page.params.code;
		if (code) connect(code);
		drain = setInterval(() => {
			if (!queue.length) return;
			// Catch up faster when far behind.
			const n = Math.max(1, Math.floor(queue.length / 8));
			applyLetters(queue.splice(0, n).join(''), n === 1);
		}, 60);
		return () => clearInterval(drain);
	});
	onDestroy(() => ws?.close());

	const avgLatency = $derived(latency.length ? latency.reduce((a, b) => a + b, 0) / latency.length : null);
</script>

<svelte:head><title>Live {page.params.code} · 2048 Lab</title></svelte:head>

<div class="grid gap-6 lg:grid-cols-[minmax(0,34rem)_1fr]">
	<div>
		<div class="mb-3 grid grid-cols-3 gap-2">
			<Stat label="Score" value={fmtInt(score)} />
			<Stat label="Max tile" value={fmtInt(maxTile(board))} />
			<Stat label="Moves" value={fmtInt(moves)} />
		</div>
		<Board {board} {step} label="Live board" />
	</div>
	<div class="space-y-4">
		<section class="card p-4">
			<div class="flex items-center gap-2">
				{#if status === 'live' && !endStatus}<span class="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500"></span><span class="text-sm font-semibold">Live</span>
				{:else if status === 'connecting'}<span class="text-sm text-ink-500">Connecting…</span>
				{:else}<span class="text-sm font-semibold">Finished{endStatus ? ` (${endStatus})` : ''}</span>{/if}
				<span class="ml-auto text-xs text-ink-500">{spectators} watching</span>
			</div>
			<h1 class="mt-3 text-2xl font-bold">{player?.name ?? (player?.kind === 'human' ? 'Human player' : 'Agent')}</h1>
			<p class="mono mt-1 text-sm text-ink-500">{page.params.code}</p>
			{#if message}<p class="mt-2 text-sm text-ink-500">{message}</p>{/if}
			<div class="mt-4 flex gap-2">
				<a class="btn-ghost" href="/replay/{page.params.code}">Open as replay</a>
				<a class="btn-ghost" href="/watch">All live games</a>
			</div>
		</section>
		<section class="card p-4">
			<h2 class="mb-3 text-sm font-semibold">Agent telemetry</h2>
			<dl class="grid grid-cols-3 gap-2 text-center">
				<div><dt class="label">Decision</dt><dd class="font-semibold tabular-nums">{fmtUs(metrics?.timeUs)}</dd></div>
				<div><dt class="label">Avg (60)</dt><dd class="font-semibold tabular-nums">{fmtUs(avgLatency)}</dd></div>
				<div><dt class="label">Nodes</dt><dd class="font-semibold tabular-nums">{fmtCompact(metrics?.nodes)}</dd></div>
			</dl>
			{#if latency.length > 1}
				{@const mx = Math.max(...latency)}
				<svg viewBox="0 0 120 30" class="mt-3 h-10 w-full" role="img" aria-label="Decision latency, last {latency.length} moves">
					<polyline fill="none" stroke="var(--series-1)" stroke-width="1.5" points={latency.map((v, i) => `${(i / (latency.length - 1)) * 120},${28 - (v / mx) * 26}`).join(' ')} />
				</svg>
			{/if}
		</section>
	</div>
</div>
