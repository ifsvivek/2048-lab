<script lang="ts">
	import { onMount } from 'svelte';
	import BarList from '$lib/charts/BarList.svelte';
	import LineChart from '$lib/charts/LineChart.svelte';
	import DataTable from '$lib/charts/DataTable.svelte';
	import { LANG_ORDER, langColor } from '$lib/charts/series';
	import { BASELINE, BASELINE_CPU, EXPECTED, type Run, SUITES, remoteRuns } from '$lib/bench-data';
	import { LANG_LABEL, fmtBytes, fmtCompact, fmtInt, fmtUs } from '$lib/format';

	let suiteId = $state('expectimax-d2-10');
	let includeRemote = $state(true);
	let remote = $state<Run[]>([]);
	let remoteError = $state('');
	let showTable = $state(false);

	onMount(async () => {
		try {
			remote = await remoteRuns();
		} catch (e) {
			remoteError = (e as Error).message;
		}
	});

	const suite = $derived(SUITES.find((s) => s.id === suiteId)!);
	const isSearch = $derived(suite.agent.id === 'expectimax');
	const runs = $derived([...BASELINE, ...(includeRemote ? remote : [])].filter((r) => r.suiteId === suiteId));
	/** Best (highest throughput) run per language — the headline comparison. */
	const best = $derived(
		Object.fromEntries(
			LANG_ORDER.map((l) => {
				const rs = runs.filter((r) => r.language === l && r.runtime !== 'browser');
				return [l, rs.length ? rs.reduce((a, b) => ((b.movesPerSec ?? 0) > (a.movesPerSec ?? 0) ? b : a)) : null];
			})
		) as Record<string, Run | null>
	);
	const items = (get: (r: Run) => number | null, detail?: (r: Run) => string) =>
		LANG_ORDER.map((l) => ({ key: l, label: LANG_LABEL[l], value: best[l] ? get(best[l]!) : null, color: langColor(l), detail: best[l] && detail ? detail(best[l]!) : undefined }));

	const fastest = $derived.by(() => {
		const xs = LANG_ORDER.map((l) => best[l]).filter((r): r is Run => !!r && !!r.movesPerSec);
		if (xs.length < 2) return null;
		const s = [...xs].sort((a, b) => b.movesPerSec! - a.movesPerSec!);
		return { top: s[0], ratio: s[0].movesPerSec! / s[s.length - 1].movesPerSec!, slow: s[s.length - 1] };
	});
	const agree = $derived.by(() => {
		const cs = new Set(runs.map((r) => r.checksum));
		return { n: runs.length, identical: cs.size === 1, expected: EXPECTED[suiteId]?.checksum, checksum: [...cs][0] };
	});
	const history = $derived(
		LANG_ORDER.map((l) => ({
			key: l,
			label: LANG_LABEL[l],
			color: langColor(l),
			points: runs.filter((r) => r.language === l && r.movesPerSec).map((r) => ({ x: r.createdAt, y: r.movesPerSec! }))
		})).filter((s) => s.points.length)
	);
</script>

<svelte:head><title>Runtime comparison · 2048 Lab</title></svelte:head>

<div class="flex flex-wrap items-end justify-between gap-4">
	<div>
		<h1 class="text-3xl font-extrabold tracking-tight">Runtime comparison</h1>
		<p class="mt-1 max-w-2xl text-ink-500">The same deterministic workload in nine languages. Because every implementation plays the <em>identical</em> games, the only thing that differs is speed.</p>
	</div>
</div>

<!-- Filters: one row above the charts -->
<div class="mt-6 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
	{#each SUITES as s (s.id)}
		<button class="rounded-full px-3 py-1.5 text-sm transition {suiteId === s.id ? 'bg-ink-900 text-white dark:bg-white dark:text-ink-950' : 'bg-ink-900/5 dark:bg-white/5'}" aria-pressed={suiteId === s.id} onclick={() => (suiteId = s.id)}>{s.id}</button>
	{/each}
	<label class="ml-auto flex items-center gap-2 text-sm text-ink-500"><input type="checkbox" bind:checked={includeRemote} class="accent-accent-500" /> include submitted runs</label>
</div>

<p class="mt-3 text-sm text-ink-500">{suite.description}</p>

<div class="mt-5 grid gap-3 sm:grid-cols-3">
	<div class="card p-4">
		<div class="label">Fastest</div>
		{#if fastest}
			<div class="mt-1 text-2xl font-bold">{LANG_LABEL[fastest.top.language]}</div>
			<div class="text-sm text-ink-500">{fastest.ratio.toFixed(fastest.ratio < 10 ? 1 : 0)}× faster than {LANG_LABEL[fastest.slow.language]}</div>
		{:else}<div class="mt-1 text-ink-500">-</div>{/if}
	</div>
	<div class="card p-4">
		<div class="label">Determinism</div>
		<div class="mt-1 text-2xl font-bold">{agree.identical && agree.checksum === agree.expected ? 'Identical' : agree.n ? 'Mismatch' : '-'}</div>
		<div class="mono text-sm text-ink-500">{agree.n} runs · checksum {agree.checksum ?? '-'}</div>
	</div>
	<div class="card p-4">
		<div class="label">Outcome</div>
		<div class="mt-1 text-2xl font-bold tabular-nums">{fmtInt(best.typescript?.avgScore ?? best.go?.avgScore ?? null)}</div>
		<div class="text-sm text-ink-500">avg score · {fmtInt(best.typescript?.totalMoves ?? best.go?.totalMoves ?? null)} moves (same in every language)</div>
	</div>
</div>

<div class="mt-6 grid gap-4 lg:grid-cols-2">
	<section class="card p-5" style="background: var(--surface-chart)">
		<h2 class="font-semibold">Throughput <span class="font-normal text-ink-500">moves / second</span></h2>
		<div class="mt-4"><BarList title="Moves per second by language" items={items((r) => r.movesPerSec, (r) => `${r.runtime} ${r.runtimeVersion}\n${fmtCompact(r.gamesPerSec)} games/s\nwall ${(r.wallMs! / 1000).toFixed(2)} s`)} format={fmtCompact} /></div>
	</section>
	{#if isSearch}
		<section class="card p-5" style="background: var(--surface-chart)">
			<h2 class="font-semibold">Decision latency <span class="font-normal text-ink-500">mean per move · lower is better</span></h2>
			<div class="mt-4"><BarList title="Average decision latency" lowerIsBetter items={items((r) => r.avgDecisionUs, (r) => `p99 ${fmtUs(r.p99DecisionUs)}`)} format={fmtUs} /></div>
		</section>
		<section class="card p-5" style="background: var(--surface-chart)">
			<h2 class="font-semibold">Search efficiency <span class="font-normal text-ink-500">nodes / second</span></h2>
			<div class="mt-4"><BarList title="Search nodes per second" items={items((r) => r.nodesPerSec)} format={fmtCompact} /></div>
			<p class="mt-3 text-xs text-ink-500">Python's dict-based transposition table caches more, so it visits fewer nodes for the same decisions (spec/AI.md §3).</p>
		</section>
	{:else}
		<section class="card p-5" style="background: var(--surface-chart)">
			<h2 class="font-semibold">Games per second</h2>
			<div class="mt-4"><BarList title="Games per second" items={items((r) => r.gamesPerSec)} format={fmtCompact} /></div>
		</section>
	{/if}
	<section class="card p-5" style="background: var(--surface-chart)">
		<h2 class="font-semibold">Peak memory <span class="font-normal text-ink-500">resident set · lower is better</span></h2>
		<div class="mt-4"><BarList title="Peak memory" lowerIsBetter items={items((r) => (r.peakMemoryBytes === null ? null : r.peakMemoryBytes / 1048576))} format={(v) => `${fmtInt(v)} MB`} /></div>
	</section>
	{#if history.some((h) => h.points.length > 1)}
		<section class="card p-5 lg:col-span-2" style="background: var(--surface-chart)">
			<h2 class="mb-3 font-semibold">Throughput history</h2>
			<LineChart title="Moves per second over time" series={history} formatY={fmtCompact} formatX={(x) => new Date(x).toLocaleDateString()} />
		</section>
	{/if}
</div>

<section class="card mt-4 p-5">
	<div class="flex items-center justify-between">
		<h2 class="font-semibold">All runs</h2>
		<button class="btn-ghost py-1.5 text-xs" onclick={() => (showTable = !showTable)} aria-expanded={showTable}>{showTable ? 'Hide' : 'Show'} table</button>
	</div>
	{#if showTable}
		<div class="mt-3">
			<DataTable
				caption="Benchmark runs for {suiteId}"
				columns={[{ key: 'lang', label: 'Language' }, { key: 'rt', label: 'Runtime' }, { key: 'src', label: 'Source' }, { key: 'mps', label: 'Moves/s', align: 'right' }, { key: 'lat', label: 'Avg decision', align: 'right' }, { key: 'nps', label: 'Nodes/s', align: 'right' }, { key: 'mem', label: 'Peak mem', align: 'right' }, { key: 'score', label: 'Avg score', align: 'right' }, { key: 'sum', label: 'Checksum' }]}
				rows={runs.map((r) => ({ lang: LANG_LABEL[r.language] ?? r.language, rt: `${r.runtime} ${r.runtimeVersion ?? ''}`, src: r.source, mps: fmtCompact(r.movesPerSec), lat: fmtUs(r.avgDecisionUs), nps: fmtCompact(r.nodesPerSec), mem: fmtBytes(r.peakMemoryBytes), score: fmtInt(r.avgScore), sum: `${r.checksum}${r.verified ? ' ✓' : ''}` }))}
			/>
		</div>
	{/if}
	<p class="mt-3 text-xs text-ink-500">Baseline measured on {BASELINE_CPU}. {remoteError ? `Submitted runs unavailable (${remoteError}).` : ''} Reproduce: <code class="mono">pnpm bench --suites {suiteId}</code>.</p>
</section>
