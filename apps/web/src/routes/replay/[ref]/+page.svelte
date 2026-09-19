<script lang="ts">
	import { page } from '$app/state';
	import { DIRECTION_NAMES, type HistoryFrame, maxTile, reconstruct, simulate } from '@g2048/engine';
	import { onDestroy } from 'svelte';
	import Board, { type BoardStep } from '$lib/components/Board.svelte';
	import CopyField from '$lib/components/CopyField.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import Timeline from '$lib/components/Timeline.svelte';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import { type ResolvedReplay, resolveReplay } from '$lib/replays';
	import { fmtInt, fmtUs } from '$lib/format';

	let replay = $state<ResolvedReplay | null>(null);
	let frames = $state<HistoryFrame[]>([]);
	let error = $state('');
	let idx = $state(0);
	let playing = $state(false);
	let speed = $state(8); // moves per second
	let verified = $state<boolean | null>(null);
	let step = $state<BoardStep | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const ref = decodeURIComponent(page.params.ref ?? '');
		replay = null;
		error = '';
		playing = false;
		resolveReplay(ref)
			.then((r) => {
				replay = r;
				frames = reconstruct(r.seed, r.moves);
				idx = 0;
				step = null;
				// Independent check: re-simulate and compare the running history hash.
				verified = r.final.historyHash ? simulate(r.seed, r.moves).historyHash === r.final.historyHash : null;
			})
			.catch((e) => (error = e.message));
	});

	function go(to: number, animate = false) {
		const t = Math.max(0, Math.min(frames.length - 1, to));
		const f = frames[t];
		step = animate && t === idx + 1 && f.dir !== null ? { prev: frames[idx].board, dir: f.dir, spawn: f.spawn } : null;
		idx = t;
	}

	function tick() {
		if (!playing) return;
		if (idx >= frames.length - 1) {
			playing = false;
			return;
		}
		go(idx + 1, speed <= 16);
		timer = setTimeout(tick, 1000 / speed);
	}

	function toggle() {
		playing = !playing;
		if (playing) {
			if (idx >= frames.length - 1) go(0);
			tick();
		} else clearTimeout(timer);
	}

	function onKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
		if (e.key === ' ') {
			e.preventDefault();
			toggle();
		} else if (e.key === 'ArrowRight') go(idx + 1, true);
		else if (e.key === 'ArrowLeft') go(idx - 1);
		else if (e.key === 'Home') go(0);
		else if (e.key === 'End') go(frames.length - 1);
	}

	onDestroy(() => clearTimeout(timer));

	const frame = $derived(frames[idx]);
	const timing = $derived(replay?.timing && idx > 0 ? replay.timing[idx - 1] : null);
	let jump = $state('');
</script>

<svelte:window onkeydown={onKey} />
<svelte:head><title>Replay {page.params.ref} · 2048 Lab</title></svelte:head>

{#if error}
	<div class="py-20 text-center">
		<p class="text-lg font-semibold">Couldn't open this replay</p>
		<p class="mt-1 text-ink-500">{error}</p>
		<a class="btn-ghost mt-6" href="/replay">Try another code</a>
	</div>
{:else if !replay || !frame}
	<div class="grid gap-6 lg:grid-cols-[minmax(0,34rem)_1fr]" aria-busy="true">
		<div class="skeleton aspect-square w-full rounded-[22px]"></div>
		<div class="card p-5"><Skeleton rows={6} /></div>
	</div>
{:else}
	<div class="grid gap-6 lg:grid-cols-[minmax(0,34rem)_1fr]">
		<div>
			<div class="mb-3 grid grid-cols-3 gap-2">
				<Stat label="Score" value={fmtInt(frame.score)} />
				<Stat label="Move" value="{idx} / {frames.length - 1}" />
				<Stat label="Max tile" value={fmtInt(maxTile(frame.board))} />
			</div>
			<Board board={frame.board} {step} label="Replay board at move {idx}" />

			<div class="card mt-4 p-3">
				<div class="mb-2 px-1 pt-5"><Timeline {frames} {idx} onseek={(i) => go(i)} /></div>
				<label class="sr-only" for="scrub">Move position</label>
				<input id="scrub" type="range" class="w-full accent-accent-500" min="0" max={frames.length - 1} value={idx} oninput={(e) => go(Number(e.currentTarget.value))} />
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<button class="btn-ghost px-3" onclick={() => go(0)} aria-label="First move">⏮</button>
					<button class="btn-ghost px-3" onclick={() => go(idx - 1)} aria-label="Previous move">◀</button>
					<button class="btn-primary w-24" onclick={toggle}>{playing ? 'Pause' : 'Play'}</button>
					<button class="btn-ghost px-3" onclick={() => go(idx + 1, true)} aria-label="Next move">▶</button>
					<button class="btn-ghost px-3" onclick={() => go(frames.length - 1)} aria-label="Last move">⏭</button>
					<label class="ml-auto flex items-center gap-2 text-sm"><span class="text-ink-500">Speed</span>
						<select class="input w-auto py-1.5" bind:value={speed}>
							{#each [1, 2, 4, 8, 16, 32, 64, 128] as s (s)}<option value={s}>{s} moves/s</option>{/each}
						</select>
					</label>
				</div>
				<form class="mt-2 flex items-center gap-2 text-sm" onsubmit={(e) => { e.preventDefault(); go(Number(jump)); }}>
					<label for="jump" class="text-ink-500">Jump to move</label>
					<input id="jump" class="input w-24 py-1.5" inputmode="numeric" bind:value={jump} placeholder={String(idx)} />
					<button class="btn-ghost py-1.5" type="submit">Go</button>
					<span class="ml-auto text-xs text-ink-500">Space · ← → · Home/End</span>
				</form>
			</div>
		</div>

		<div class="space-y-4">
			<section class="card p-4">
				<div class="flex items-center justify-between">
					<h1 class="text-lg font-bold">{replay.agent?.name ?? (replay.playerKind === 'agent' ? 'Agent' : 'Human')} game</h1>
					{#if replay.status === 'live'}
						<a class="rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-600 dark:text-red-400" href="/watch/{replay.replayCode}">● Live — watch</a>
					{:else if verified}
						<span class="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400" title="Reconstructed locally from seed + moves; matches the stored final state">✓ Verified replay</span>
					{/if}
				</div>
				<p class="mt-1 text-sm text-ink-500">
					Final {fmtInt(replay.final.score)} · {replay.moves.length} moves · {replay.status ?? ''}
					{#if replay.origin !== 'api'}· <span title="Served without the network">{replay.origin === 'local' ? 'from this device' : 'cached offline'}</span>{/if}
				</p>
				<div class="mt-4 grid grid-cols-1 min-[440px]:grid-cols-2 gap-3">
					{#if replay.replayCode}<CopyField label="Replay code" value={replay.replayCode} href="{location.origin}/replay/{replay.replayCode}" />{/if}
					<CopyField label="Seed" value={String(replay.seed)} />
					{#if replay.gameId}<div class="min-[440px]:col-span-2"><CopyField label="Game ID" value={replay.gameId} /></div>{/if}
				</div>
			</section>
			<section class="card p-4 text-sm">
				<h2 class="mb-2 font-semibold">This move</h2>
				{#if idx === 0}
					<p class="text-ink-500">Initial position — two spawned tiles.</p>
				{:else}
					<dl class="grid grid-cols-2 gap-y-1">
						<dt class="text-ink-500">Direction</dt><dd class="font-semibold">{DIRECTION_NAMES[frame.dir ?? 0]}</dd>
						<dt class="text-ink-500">Points gained</dt><dd class="tabular-nums">{fmtInt(frame.gained)}</dd>
						<dt class="text-ink-500">Spawned</dt><dd>{frame.spawn ? `${2 ** frame.spawn.exponent} at row ${Math.floor(frame.spawn.index / 4) + 1}, col ${(frame.spawn.index % 4) + 1}` : '—'}</dd>
						{#if timing}<dt class="text-ink-500">Decision time</dt><dd class="tabular-nums">{fmtUs(timing)}</dd>{/if}
					</dl>
				{/if}
			</section>
			{#if (replay as any).llmUsage}
				{@const u = (replay as any).llmUsage}
				<section class="card p-4 text-sm">
					<h2 class="mb-2 font-semibold">LLM burn <span class="font-normal text-ink-500">self-reported</span></h2>
					<dl class="grid grid-cols-2 gap-y-1">
						<dt class="text-ink-500">Model</dt><dd class="font-medium">{u.model}</dd>
						<dt class="text-ink-500">Tokens</dt><dd class="tabular-nums">{fmtInt(u.tokens.total)} <span class="text-ink-500">({fmtInt(u.tokens.input)} in · {fmtInt(u.tokens.output)} out)</span></dd>
						<dt class="text-ink-500">Cost</dt><dd class="tabular-nums">{u.costUsd === null ? 'unknown' : `$${u.costUsd.toFixed(u.costUsd < 1 ? 4 : 2)}`}{u.costEstimated ? ' (estimated)' : ''}</dd>
						<dt class="text-ink-500">Model calls</dt><dd class="tabular-nums">{fmtInt(u.calls)}</dd>
						{#if u.efficiency?.tokensPerMove}<dt class="text-ink-500">Tokens / move</dt><dd class="tabular-nums">{fmtInt(u.efficiency.tokensPerMove)}</dd>{/if}
					</dl>
				</section>
			{/if}
			{#if replay.runtime || replay.agent?.config}
				<section class="card p-4 text-sm">
					<h2 class="mb-2 font-semibold">Runtime</h2>
					<pre class="mono overflow-x-auto text-xs text-ink-600 dark:text-ink-300">{JSON.stringify({ runtime: replay.runtime, agent: replay.agent }, null, 2)}</pre>
				</section>
			{/if}
		</div>
	</div>
{/if}
