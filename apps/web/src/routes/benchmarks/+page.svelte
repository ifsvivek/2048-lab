<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { BenchmarkResult, GameResult } from '@g2048/engine/sim';
	import { AiWorker } from '$lib/ai/client';
	import { api } from '$lib/api';
	import { EXPECTED, type Run, SUITES, remoteRuns } from '$lib/bench-data';
	import Columns from '$lib/charts/Columns.svelte';
	import DataTable from '$lib/charts/DataTable.svelte';
	import Stat from '$lib/components/Stat.svelte';
	import { LANG_LABEL, fmtAgo, fmtBytes, fmtCompact, fmtInt, fmtUs } from '$lib/format';

	// Browser-friendly suites (the 10k and canonical suites are for native runners).
	const BROWSER_SUITES = SUITES.filter((s) => ['engine-random-1k', 'expectimax-d2-10', 'expectimax-d3-opening'].includes(s.id));
	let suiteId = $state('engine-random-1k');
	let worker: AiWorker | null = null;
	let running = $state(false);
	let progress = $state<{ done: number; total: number; last: GameResult | null }>({ done: 0, total: 0, last: null });
	let result = $state<BenchmarkResult | null>(null);
	let submitted = $state<{ id: string; verified: boolean } | null>(null);
	let submitErr = $state('');
	let runs = $state<Run[]>([]);

	// Server sessions
	let sessAgent = $state('builtin/expectimax');
	let sessGames = $state(3);
	let session = $state<any>(null);
	let sessErr = $state('');
	let poll: ReturnType<typeof setInterval> | undefined;

	onMount(async () => {
		try {
			runs = await remoteRuns();
		} catch {
			/* offline */
		}
	});
	onDestroy(() => {
		worker?.terminate();
		clearInterval(poll);
	});

	async function run() {
		const suite = BROWSER_SUITES.find((s) => s.id === suiteId)!;
		running = true;
		result = null;
		submitted = null;
		progress = { done: 0, total: suite.seeds.count, last: null };
		worker?.terminate();
		worker = new AiWorker();
		try {
			result = await worker.bench(suite, (p) => (progress = { done: p.done, total: p.total, last: p.game }));
		} finally {
			running = false;
		}
	}

	async function submit() {
		if (!result) return;
		submitErr = '';
		try {
			submitted = await api('/v1/benchmarks/runs', { body: result });
			runs = await remoteRuns();
		} catch (e) {
			submitErr = (e as Error).message;
		}
	}

	async function startSession() {
		sessErr = '';
		try {
			session = await api('/v1/benchmarks/sessions', { body: { agent: sessAgent, games: sessGames, seedStart: 1, maxMoves: 5000 } });
			clearInterval(poll);
			poll = setInterval(async () => {
				session = await api(`/v1/benchmarks/sessions/${session.benchmarkId}`);
				if (session.status !== 'running') clearInterval(poll);
			}, 1500);
		} catch (e) {
			sessErr = (e as Error).message;
		}
	}

	const tiles = $derived.by(() => {
		if (!result) return [];
		const dist = result.summary.tileDistribution;
		const keys = Object.keys(dist).map(Number).sort((a, b) => a - b);
		return keys.map((k) => ({ label: k >= 1024 ? `${k / 1024}k` : String(k), value: dist[k], note: `${dist[k]} games ended with max tile ${k}` }));
	});
</script>

<svelte:head><title>Benchmarks · 2048 Lab</title></svelte:head>

<h1 class="text-3xl font-extrabold tracking-tight">Benchmarks</h1>
<p class="mt-1 max-w-2xl text-ink-500">Reproducible suites shared by every implementation. Run one in this browser, submit it, and compare against native runtimes on the <a class="underline" href="/runtimes">runtime dashboard</a>.</p>

<div class="mt-6 grid gap-4 lg:grid-cols-[1fr_1fr]">
	<section class="card p-5">
		<h2 class="font-semibold">Run in this browser</h2>
		<div class="mt-3 space-y-2">
			{#each BROWSER_SUITES as s (s.id)}
				<label class="flex cursor-pointer gap-3 rounded-xl p-2.5 hover:bg-ink-900/[0.03] dark:hover:bg-white/[0.03]">
					<input type="radio" name="suite" value={s.id} bind:group={suiteId} class="mt-1 accent-accent-500" disabled={running} />
					<span><span class="font-medium">{s.name}</span><span class="block text-xs text-ink-500">{s.description}</span></span>
				</label>
			{/each}
		</div>
		<div class="mt-4 flex items-center gap-3">
			<button class="btn-primary" onclick={run} disabled={running}>{running ? 'Running…' : 'Run benchmark'}</button>
			{#if running}
				<div class="flex-1">
					<div class="h-1.5 rounded-full bg-ink-900/10 dark:bg-white/10"><div class="h-full rounded-full bg-accent-500 transition-[width]" style:width="{(progress.done / Math.max(1, progress.total)) * 100}%"></div></div>
					<div class="mt-1 text-xs text-ink-500 tabular-nums">game {progress.done}/{progress.total}{progress.last ? ` · last score ${fmtInt(progress.last.score)}` : ''}</div>
				</div>
			{/if}
		</div>
	</section>

	<section class="card p-5">
		<h2 class="font-semibold">Result</h2>
		{#if !result}
			<p class="mt-3 text-sm text-ink-500">Run a suite to see throughput, latency, score and tile distribution.</p>
		{:else}
			{@const s = result.summary}
			{@const ok = EXPECTED[result.suiteId]?.checksum === result.checksum}
			<div class="mt-3 grid grid-cols-3 gap-2">
				<Stat label="Moves/s" value={fmtCompact(s.movesPerSec)} />
				<Stat label="Games/s" value={fmtCompact(s.gamesPerSec)} />
				<Stat label="Avg decision" value={fmtUs(s.avgDecisionUs)} />
				<Stat label="Avg score" value={fmtInt(s.avgScore)} />
				<Stat label="Max score" value={fmtInt(s.maxScore)} />
				<Stat label="JS heap" value={fmtBytes(s.peakMemoryBytes)} />
			</div>
			<p class="mt-3 text-sm">
				Checksum <span class="mono">{result.checksum}</span>
				{#if ok}<span class="ml-1 font-semibold text-emerald-700 dark:text-emerald-400">✓ matches the reference — identical games to Rust, Go and Python</span>{:else}<span class="ml-1 font-semibold text-red-600">✗ differs from reference</span>{/if}
			</p>
			<div class="mt-4"><div class="label mb-2">Max tile distribution</div><Columns title="Games by max tile" data={tiles} /></div>
			<div class="mt-4 flex items-center gap-3">
				<button class="btn-ghost" onclick={submit} disabled={!!submitted}>{submitted ? 'Submitted' : 'Submit result'}</button>
				{#if submitted}<span class="text-sm text-ink-500">run {submitted.id.slice(-6)} · {submitted.verified ? 'verified' : 'unverified'}</span>{/if}
				{#if submitErr}<span class="text-sm text-red-600">{submitErr}</span>{/if}
			</div>
		{/if}
	</section>
</div>

<section class="card mt-4 p-5">
	<h2 class="font-semibold">Server-side session</h2>
	<p class="mt-1 text-sm text-ink-500">The platform plays N seeds with an agent inside a Durable Object and records a benchmark run. Registered push agents can be benchmarked with their API key (see <a class="underline" href="/agents">Agents</a>).</p>
	<div class="mt-3 flex flex-wrap items-end gap-3">
		<label class="text-sm"><span class="label">Agent</span><select class="input mt-1" bind:value={sessAgent}><option value="builtin/expectimax">builtin/expectimax (depth 2)</option><option value="builtin/greedy">builtin/greedy</option></select></label>
		<label class="text-sm"><span class="label">Games</span><input class="input mt-1 w-24" type="number" min="1" max="20" bind:value={sessGames} /></label>
		<button class="btn-primary" onclick={startSession} disabled={session?.status === 'running'}>Start session</button>
		{#if sessErr}<span class="text-sm text-red-600">{sessErr}</span>{/if}
	</div>
	{#if session}
		<div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
			<Stat label="Status" value={session.status} />
			<Stat label="Games" value="{session.gamesCompleted}/{session.gamesTotal}" />
			<Stat label="Avg score" value={fmtInt(session.summary?.avgScore)} />
			<Stat label="Checksum" value={session.checksum ?? '…'} />
		</div>
		{#if session.current}<p class="mt-2 text-sm text-ink-500">Now playing seed {session.current.seed}: move {session.current.moveNumber}, score {fmtInt(session.current.score)}</p>{/if}
	{/if}
</section>

<section class="card mt-4 p-5">
	<h2 class="font-semibold">Recent submitted runs</h2>
	{#if runs.length === 0}
		<p class="mt-2 text-sm text-ink-500">No submitted runs yet (or you're offline). Native runners: <code class="mono">pnpm bench --submit &lt;api-url&gt;</code>.</p>
	{:else}
		<div class="mt-3">
			<DataTable
				caption="Recent benchmark runs"
				columns={[{ key: 'suite', label: 'Suite' }, { key: 'lang', label: 'Language' }, { key: 'rt', label: 'Runtime' }, { key: 'mps', label: 'Moves/s', align: 'right' }, { key: 'score', label: 'Avg score', align: 'right' }, { key: 'v', label: 'Verified' }, { key: 'when', label: 'When' }]}
				rows={runs.slice(0, 25).map((r) => ({ suite: r.suiteId, lang: LANG_LABEL[r.language] ?? r.language, rt: r.runtime, mps: fmtCompact(r.movesPerSec), score: fmtInt(r.avgScore), v: r.verified ? '✓' : '—', when: fmtAgo(r.createdAt) }))}
			/>
		</div>
	{/if}
</section>
