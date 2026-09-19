<script lang="ts">
	import { onMount } from 'svelte';
	import { ApiUnavailable, api } from '$lib/api';
	import { getMeta, setMeta } from '$lib/store';
	import BarList from '$lib/charts/BarList.svelte';
	import Columns from '$lib/charts/Columns.svelte';
	import LineChart from '$lib/charts/LineChart.svelte';
	import DataTable from '$lib/charts/DataTable.svelte';
	import { LANG_LABEL, fmtCompact, fmtInt, fmtUs } from '$lib/format';

	type Any = Record<string, any>;
	let overview = $state<Any | null>(null);
	let platform = $state<Any | null>(null);
	let players = $state<Any | null>(null);
	let scores = $state<Any | null>(null);
	let tiles = $state<Any | null>(null);
	let moves = $state<Any | null>(null);
	let agents = $state<Any | null>(null);
	let boards = $state<Any | null>(null);
	let devices = $state<Any | null>(null);
	let llm = $state<Any | null>(null);
	let offline = $state(false);
	let granularity = $state<'day' | 'week' | 'month'>('day');
	let scoreKind = $state<'all' | 'human' | 'agent'>('all');
	let moveKind = $state<'human' | 'agent'>('human');

	/** Network-first with an IndexedDB copy so the dashboard still renders offline. */
	async function load<T>(path: string): Promise<T | null> {
		try {
			const v = await api<T>(path);
			setMeta(`analytics:${path}`, v);
			return v;
		} catch (e) {
			if (e instanceof ApiUnavailable) offline = true;
			return ((await getMeta<T>(`analytics:${path}`)) ?? null) as T | null;
		}
	}

	onMount(async () => {
		const r = await Promise.all([
			load<Any>('/v1/analytics/overview'),
			load<Any>(`/v1/analytics/platform?granularity=${granularity}`),
			load<Any>('/v1/analytics/players'),
			load<Any>(`/v1/analytics/scores?kind=${scoreKind}`),
			load<Any>('/v1/analytics/tiles'),
			load<Any>('/v1/analytics/moves'),
			load<Any>('/v1/analytics/agents'),
			load<Any>('/v1/analytics/leaderboards'),
			load<Any>('/v1/analytics/devices'),
			load<Any>('/v1/analytics/llm')
		]);
		[overview, platform, players, scores, tiles, moves, agents, boards, devices, llm] = r;
	});

	async function setGranularity(g: typeof granularity) {
		granularity = g;
		platform = await load(`/v1/analytics/platform?granularity=${g}`);
	}
	async function setScoreKind(k: typeof scoreKind) {
		scoreKind = k;
		scores = await load(`/v1/analytics/scores?kind=${k}`);
	}

	const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`);
	const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v < 60000 ? `${(v / 1000).toFixed(0)} s` : `${(v / 60000).toFixed(1)} min`);
	const tileLabel = (t: number) => (t >= 1024 ? `${t / 1024}k` : String(t));
	const lang = (l: string) => LANG_LABEL[l] ?? l;
	function runtimeRows(b: Any): [string, string][] {
		const row = (r: Any | undefined, unit: string) => (r ? `${lang(r.language)} · ${fmtCompact(r.value)} ${unit}` : '—');
		return [
			['Fastest engine', row(b.runtimes.fastestEngine[0], 'moves/s')],
			['Fastest search', row(b.runtimes.fastestSearch[0], 'moves/s')],
			['Most efficient', row(b.runtimes.mostEfficient[0], 'moves/s per MB')]
		];
	}
	function scoreBoards(b: Any): { title: string; rows: Any[]; value: (g: Any) => string }[] {
		return [
			{ title: 'Highest scores', rows: b.scores.highest, value: (g) => fmtInt(g.score) },
			{ title: 'Highest tiles', rows: b.scores.highestTiles, value: (g) => fmtInt(g.maxTile) },
			{ title: 'Longest runs', rows: b.scores.longestRuns, value: (g) => `${fmtInt(g.moves)} moves` }
		];
	}
	const SECTIONS = ['overview', 'platform', 'players', 'scores', 'tiles', 'moves', 'agents', 'llm', 'leaderboards', 'devices'];
	const usd = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(5)}` : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
</script>

<svelte:head><title>Analytics · 2048 Lab</title></svelte:head>

<div class="flex flex-wrap items-end justify-between gap-3">
	<div>
		<h1 class="text-3xl font-extrabold tracking-tight">Analytics &amp; insights</h1>
		<p class="mt-1 max-w-2xl text-ink-500">Platform growth, player behaviour, game difficulty and agent performance — served from incremental aggregates, never raw scans.</p>
	</div>
	{#if offline}<span class="rounded-full bg-accent-500/15 px-3 py-1 text-xs font-semibold text-accent-600">Offline — showing cached figures</span>{/if}
</div>

<nav aria-label="Analytics sections" class="sticky top-14 z-20 -mx-4 mt-4 flex gap-1 overflow-x-auto bg-ink-50/90 px-4 py-2 backdrop-blur dark:bg-ink-950/90 [scrollbar-width:none]">
	{#each SECTIONS as s (s)}<a href="#{s}" class="rounded-lg px-2.5 py-1 text-sm whitespace-nowrap text-ink-600 {s === 'llm' ? '' : 'capitalize'} hover:bg-ink-900/5 dark:text-ink-300 dark:hover:bg-white/5">{s === 'llm' ? 'LLM usage' : s}</a>{/each}
</nav>

<!-- ============================================================ executive -->
<section id="overview" class="scroll-mt-28 pt-4">
	{#if !overview}
		<p class="py-10 text-center text-ink-500">Loading…</p>
	{:else}
		{@const t = overview.totals}
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
			{#each [
				['Total games', fmtInt(t.games), `${fmtInt(overview.last7Days.games)} in the last 7 days`],
				['Total players', fmtInt(t.players), 'anonymous browsers'],
				['Average score', fmtInt(t.avgScore), `P99 ${fmtInt(t.p99Score)}`],
				['Highest score', fmtInt(t.highestScore), `${fmtInt(t.completedGames)} completed games`],
				['Total moves', fmtCompact(t.totalMoves), `${fmtInt(t.avgMovesPerGame)} per game`],
				['Active games', fmtInt(t.activeGames), 'live on the platform now'],
				['Benchmark runs', fmtInt(t.benchmarkRuns), `${fmtInt(t.registeredAgents)} registered agents`],
				['Replay views', fmtInt(t.replayViews), `${fmtInt(t.gamesStarted)} browser games started`]
			] as [label, value, sub] (label)}
				<div class="card p-4">
					<div class="label">{label}</div>
					<div class="mt-1 text-3xl font-extrabold tracking-tight tabular-nums">{value}</div>
					<div class="mt-0.5 text-xs text-ink-500">{sub}</div>
				</div>
			{/each}
		</div>
		<div class="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_2fr]">
			<div class="card p-4">
				<div class="label">Top-performing agent</div>
				{#if overview.topAgent}
					<div class="mt-1 text-xl font-bold">{overview.topAgent.name}</div>
					<div class="text-sm text-ink-500">avg {fmtInt(overview.topAgent.avgScore)} over {overview.topAgent.games} games</div>
				{:else}<div class="mt-1 text-sm text-ink-500">Needs ≥ 3 finished games.</div>{/if}
			</div>
			<div class="card p-4">
				<div class="label">Top-performing runtime</div>
				{#if overview.topRuntime}
					<div class="mt-1 text-xl font-bold">{LANG_LABEL[overview.topRuntime.language] ?? overview.topRuntime.language}</div>
					<div class="text-sm text-ink-500">{fmtCompact(overview.topRuntime.movesPerSec)} moves/s · {overview.topRuntime.suite}</div>
				{:else}<div class="mt-1 text-sm text-ink-500">No verified runs submitted yet — <a class="underline" href="/runtimes">see baseline</a>.</div>{/if}
			</div>
			<div class="card p-4" style="background: var(--surface-chart)">
				<div class="label mb-2">Games per day · last 30 days</div>
				<Columns title="Games per day" data={overview.sparkline.map((d: Any) => ({ label: d.day.slice(8), value: d.games, note: `${d.day}: ${d.games} games` }))} format={(v) => (v ? fmtCompact(v) : '')} />
			</div>
		</div>
	{/if}
</section>

<!-- ============================================================ platform -->
<section id="platform" class="scroll-mt-28 pt-12">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 class="text-xl font-bold">Platform growth</h2>
		<div class="flex gap-1 rounded-xl bg-ink-900/5 p-1 dark:bg-white/5" role="tablist" aria-label="Granularity">
			{#each ['day', 'week', 'month'] as g (g)}
				<button role="tab" aria-selected={granularity === g} class="rounded-lg px-3 py-1 text-sm capitalize aria-selected:bg-white aria-selected:font-semibold dark:aria-selected:bg-white/10" onclick={() => setGranularity(g as typeof granularity)}>{g === 'day' ? 'Daily' : g === 'week' ? 'Weekly' : 'Monthly'}</button>
			{/each}
		</div>
	</div>
	{#if platform}
		<div class="mt-3 grid gap-4 lg:grid-cols-2">
			<div class="card p-5" style="background: var(--surface-chart)">
				<h3 class="mb-3 font-semibold">Finished games</h3>
				<Columns title="Finished games per period" data={platform.series.slice(-31).map((s: Any) => ({ label: granularity === 'month' ? s.period.slice(2) : s.period.slice(5), value: s.games, note: `${s.period}: ${s.games} games, ${s.completed} completed` }))} format={(v) => (v ? fmtCompact(v) : '')} />
			</div>
			<div class="card p-5" style="background: var(--surface-chart)">
				<h3 class="mb-3 font-semibold">Players <span class="font-normal text-ink-500">{granularity === 'day' ? 'active' : 'active player-days'}</span></h3>
				<LineChart
					title="Active, new and returning players"
					height={180}
					series={[
						{ key: 'active', label: 'Active', color: 'var(--series-1)', points: platform.series.map((s: Any, i: number) => ({ x: i, y: s.activePlayers })) },
						{ key: 'new', label: 'New', color: 'var(--series-2)', points: platform.series.map((s: Any, i: number) => ({ x: i, y: s.newPlayers })) },
						{ key: 'ret', label: 'Returning', color: 'var(--series-3)', points: platform.series.map((s: Any, i: number) => ({ x: i, y: s.returningPlayers })) }
					]}
					formatY={fmtCompact}
					formatX={(i) => platform?.series[i]?.period ?? ''}
				/>
			</div>
		</div>
		<details class="card mt-3 p-4">
			<summary class="cursor-pointer text-sm font-semibold">Period table</summary>
			<div class="mt-3">
				<DataTable caption="Platform metrics per period" columns={[{ key: 'p', label: 'Period' }, { key: 'g', label: 'Games', align: 'right' }, { key: 'c', label: 'Completed', align: 'right' }, { key: 'm', label: 'Moves', align: 'right' }, { key: 'am', label: 'Avg moves', align: 'right' }, { key: 'rv', label: 'Replay views', align: 'right' }, { key: 'gs', label: 'Games started', align: 'right' }, { key: 'b', label: 'Bench runs', align: 'right' }, { key: 'a', label: 'New agents', align: 'right' }]} rows={[...platform.series].reverse().map((s: Any) => ({ p: s.period, g: fmtInt(s.games), c: fmtInt(s.completed), m: fmtCompact(s.moves), am: fmtInt(s.avgMoves), rv: fmtInt(s.replayViews), gs: fmtInt(s.gamesStarted), b: fmtInt(s.benchmarkRuns), a: fmtInt(s.newAgents) }))} />
			</div>
		</details>
	{/if}
</section>

<!-- ============================================================= players -->
<section id="players" class="scroll-mt-28 pt-12">
	<h2 class="text-xl font-bold">Players</h2>
	{#if players}
		<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
			{#each [
				['Unique players', fmtInt(players.uniquePlayers)],
				['New (30 days)', fmtInt(players.newPlayers30d)],
				['Returning player-days (30d)', fmtInt(players.returningPlayerDays30d)],
				['Games per player', players.gamesPerPlayer?.toFixed(1) ?? '—'],
				['Avg session length', ms(players.avgSessionMs)],
				['Avg score per player', fmtInt(players.avgScorePerPlayer)],
				['Avg best per player', fmtInt(players.avgHighestScorePerPlayer)],
				['Highest (any player)', fmtInt(players.highestScorePerPlayer)]
			] as [l, v] (l)}
				<div class="card p-4"><div class="label">{l}</div><div class="mt-1 text-2xl font-bold tabular-nums">{v}</div></div>
			{/each}
		</div>
		<div class="card mt-3 p-5">
			<h3 class="font-semibold">Retention</h3>
			<div class="mt-3 grid grid-cols-3 gap-3">
				{#each [['D1', players.retention.d1], ['D7', players.retention.d7], ['D30', players.retention.d30]] as [l, r] (l)}
					<div class="rounded-xl bg-ink-900/[0.04] p-3 dark:bg-white/5">
						<div class="label">{l} retention</div>
						<div class="mt-1 text-2xl font-bold tabular-nums">{r.rate === null ? '—' : pct(r.rate, 1)}</div>
						<div class="text-xs text-ink-500">{r.rate === null ? `not enough data (${r.cohortPlayers} players in eligible cohorts)` : `${fmtInt(r.cohortPlayers)} players in cohorts`}</div>
					</div>
				{/each}
			</div>
			<p class="mt-3 text-xs text-ink-500">{players.note} {players.snapshotAt ? `Snapshot ${new Date(players.snapshotAt).toLocaleString()}.` : 'The first snapshot is written by the daily rollup.'}</p>
		</div>
	{/if}
</section>

<!-- ============================================================== scores -->
<section id="scores" class="scroll-mt-28 pt-12">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 class="text-xl font-bold">Scores</h2>
		<div class="flex gap-1 rounded-xl bg-ink-900/5 p-1 dark:bg-white/5" role="tablist" aria-label="Player type">
			{#each ['all', 'human', 'agent'] as k (k)}
				<button role="tab" aria-selected={scoreKind === k} class="rounded-lg px-3 py-1 text-sm capitalize aria-selected:bg-white aria-selected:font-semibold dark:aria-selected:bg-white/10" onclick={() => setScoreKind(k as typeof scoreKind)}>{k === 'all' ? 'Everyone' : k === 'human' ? 'Humans' : 'Agents'}</button>
			{/each}
		</div>
	</div>
	{#if scores}
		{@const s = scores.summary}
		<div class="mt-3 grid grid-cols-3 gap-2 md:grid-cols-6">
			{#each [['Games', fmtInt(s.games)], ['Average', fmtInt(s.avg)], ['Median', fmtInt(s.median)], ['Max', fmtInt(s.max)], ['Min', fmtInt(s.min)], ['Std-dev', fmtInt(s.stdDev)]] as [l, v] (l)}
				<div class="card p-3"><div class="label">{l}</div><div class="text-xl font-bold tabular-nums">{v}</div></div>
			{/each}
		</div>
		<div class="mt-2 grid grid-cols-3 gap-2 md:grid-cols-6">
			{#each [['P50', s.p50], ['P75', s.p75], ['P90', s.p90], ['P95', s.p95], ['P99', s.p99], ['P99.9', s.p99_9]] as [l, v] (l)}
				<div class="rounded-xl bg-ink-900/[0.04] p-3 dark:bg-white/5"><div class="label">{l}</div><div class="text-lg font-semibold tabular-nums">≈{fmtInt(v)}</div></div>
			{/each}
		</div>
		<div class="mt-3 grid gap-4 lg:grid-cols-2">
			<div class="card p-5" style="background: var(--surface-chart)">
				<h3 class="mb-3 font-semibold">Score distribution <span class="font-normal text-ink-500">log-scale bins</span></h3>
				<Columns title="Score histogram" data={scores.histogram.map((b: Any) => ({ label: fmtCompact(b.from), value: b.n, note: `${fmtInt(b.from)}–${fmtInt(b.to)}: ${b.n} games` }))} />
			</div>
			<div class="card p-5" style="background: var(--surface-chart)">
				<h3 class="mb-3 font-semibold">Score over time</h3>
				<LineChart
					title="Daily score percentiles"
					height={200}
					series={[
						{ key: 'p50', label: 'P50', color: 'var(--series-1)', points: scores.trend.map((d: Any) => ({ x: Date.parse(d.day), y: d.p50 ?? 0 })) },
						{ key: 'avg', label: 'Mean', color: 'var(--series-2)', points: scores.trend.map((d: Any) => ({ x: Date.parse(d.day), y: d.avg ?? 0 })) },
						{ key: 'p90', label: 'P90', color: 'var(--series-3)', points: scores.trend.map((d: Any) => ({ x: Date.parse(d.day), y: d.p90 ?? 0 })) },
						{ key: 'p99', label: 'P99', color: 'var(--series-4)', points: scores.trend.map((d: Any) => ({ x: Date.parse(d.day), y: d.p99 ?? 0 })) }
					]}
					formatY={fmtCompact}
					formatX={(x) => new Date(x).toISOString().slice(5, 10)}
				/>
			</div>
		</div>
		<p class="mt-2 text-xs text-ink-500">{scores.note}</p>
	{/if}
</section>

<!-- =============================================================== tiles -->
<section id="tiles" class="scroll-mt-28 pt-12">
	<h2 class="text-xl font-bold">Tile achievements</h2>
	{#if tiles}
		<div class="mt-3 grid gap-4 lg:grid-cols-2">
			<div class="card p-5" style="background: var(--surface-chart)">
				<h3 class="mb-3 font-semibold">Share of games reaching each tile</h3>
				<BarList markBest={false} title="Games reaching tile" items={tiles.tiles.map((t: Any) => ({ key: String(t.tile), label: tileLabel(t.tile), value: t.gameRate * 100, color: 'var(--seq-400)', detail: `${fmtInt(t.games)} games\nhumans ${pct(t.humanRate, 1)} · agents ${pct(t.agentRate, 1)}` }))} format={(v) => `${v.toFixed(v < 10 ? 1 : 0)}%`} />
			</div>
			<div class="card p-5" style="background: var(--surface-chart)">
				<h3 class="mb-3 font-semibold">Share of players who ever reached it</h3>
				<BarList markBest={false} title="Players reaching tile" items={tiles.tiles.map((t: Any) => ({ key: String(t.tile), label: tileLabel(t.tile), value: t.playerRate === null ? null : t.playerRate * 100, color: 'var(--seq-400)', detail: `${fmtInt(t.players)} players` }))} format={(v) => `${v.toFixed(v < 10 ? 1 : 0)}%`} />
			</div>
		</div>
	{/if}
</section>

<!-- =============================================================== moves -->
<section id="moves" class="scroll-mt-28 pt-12">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 class="text-xl font-bold">Moves</h2>
		<div class="flex gap-1 rounded-xl bg-ink-900/5 p-1 dark:bg-white/5" role="tablist" aria-label="Player type">
			{#each ['human', 'agent'] as k (k)}
				<button role="tab" aria-selected={moveKind === k} class="rounded-lg px-3 py-1 text-sm capitalize aria-selected:bg-white aria-selected:font-semibold dark:aria-selected:bg-white/10" onclick={() => (moveKind = k as typeof moveKind)}>{k === 'human' ? 'Humans' : 'AI agents'}</button>
			{/each}
		</div>
	</div>
	{#if moves}
		{@const m = moves[moveKind]}
		{@const total = Object.values(m.frequency as Record<string, number>).reduce((a, b) => a + b, 0)}
		<div class="mt-3 grid grid-cols-3 gap-2 md:grid-cols-6">
			{#each [['Avg moves', fmtInt(m.avgMoves)], ['Median', `≈${fmtInt(m.medianMoves)}`], ['Longest', fmtInt(m.longestGame)], ['Shortest', fmtInt(m.shortestGame)], ['Avg latency', fmtUs(m.avgLatencyUs)], ['Avg game', ms(m.avgGameDurationMs)]] as [l, v] (l)}
				<div class="card p-3"><div class="label">{l}</div><div class="text-xl font-bold tabular-nums">{v}</div></div>
			{/each}
		</div>
		<div class="mt-3 grid gap-4 lg:grid-cols-2">
			<div class="card p-5" style="background: var(--surface-chart)">
				<h3 class="mb-3 font-semibold">Move frequency</h3>
				<BarList markBest={false} title="Move direction frequency" items={['up', 'down', 'left', 'right'].map((d) => ({ key: d, label: d, value: total ? (m.frequency[d] / total) * 100 : null, color: 'var(--seq-400)', detail: `${fmtInt(m.frequency[d])} moves` }))} format={(v) => `${v.toFixed(1)}%`} />
			</div>
			<div class="card p-5" style="background: var(--surface-chart)">
				<h3 class="mb-3 font-semibold">Game length distribution</h3>
				<Columns title="Moves per game histogram" data={m.histogram.map((b: Any) => ({ label: fmtCompact(b.from), value: b.n, note: `${fmtInt(b.from)}–${fmtInt(b.to)} moves: ${b.n} games` }))} />
			</div>
		</div>
	{/if}
</section>

<!-- ============================================================== agents -->
<section id="agents" class="scroll-mt-28 pt-12">
	<h2 class="text-xl font-bold">Agents</h2>
	{#if agents}
		{#if agents.agents.length === 0}
			<p class="mt-3 text-sm text-ink-500">No agent games recorded yet.</p>
		{:else}
			<div class="mt-3 grid gap-4 lg:grid-cols-[1fr_2fr]">
				<div class="card p-5" style="background: var(--surface-chart)">
					<h3 class="mb-3 font-semibold">Average score</h3>
					<BarList title="Average score by agent" items={agents.agents.slice(0, 8).map((a: Any) => ({ key: a.key, label: a.name, value: a.avgScore, color: 'var(--seq-400)', detail: `${a.games} games · best ${fmtInt(a.maxScore)}` }))} format={fmtCompact} />
				</div>
				<div class="card p-5">
					<DataTable
						caption="Agent comparison"
						columns={[{ key: 'n', label: 'Agent' }, { key: 'g', label: 'Games', align: 'right' }, { key: 'avg', label: 'Avg', align: 'right' }, { key: 'med', label: 'Median', align: 'right' }, { key: 'p90', label: 'P90', align: 'right' }, { key: 'p99', label: 'P99', align: 'right' }, { key: 'max', label: 'Max', align: 'right' }, { key: 't', label: 'Top tile', align: 'right' }, { key: 'dt', label: 'Decision', align: 'right' }, { key: 'd', label: 'Depth', align: 'right' }, { key: 'c', label: 'Completed', align: 'right' }]}
						rows={agents.agents.map((a: Any) => ({ n: a.name, g: fmtInt(a.games), avg: fmtInt(a.avgScore), med: fmtInt(a.medianScore), p90: fmtInt(a.p90Score), p99: fmtInt(a.p99Score), max: fmtInt(a.maxScore), t: fmtInt(a.highestTile), dt: fmtUs(a.avgDecisionUs), d: a.avgDepth ? a.avgDepth.toFixed(1) : '—', c: fmtInt(a.completed) }))}
					/>
				</div>
			</div>
		{/if}
	{/if}
</section>

<!-- =========================================================== llm usage -->
<section id="llm" class="scroll-mt-28 pt-12">
	<h2 class="text-xl font-bold">LLM usage <span class="text-base font-normal text-ink-500">tokens &amp; money burnt by LLM players</span></h2>
	{#if llm}
		{#if llm.totals.games === 0}
			<p class="mt-3 text-sm text-ink-500">No LLM has reported usage yet. MCP clients call <code class="mono">report_usage</code> at the end of a game; REST agents POST to <code class="mono">/v1/games/&#123;id&#125;/usage</code>.</p>
		{:else}
			<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
				{#each [
					['Money burnt', usd(llm.totals.costUsd), llm.totals.unpricedGames ? `+ ${llm.totals.unpricedGames} ${llm.totals.unpricedGames === 1 ? 'game' : 'games'} with unknown pricing` : 'all games priced'],
					['Tokens burnt', fmtCompact(llm.totals.tokens), `${fmtCompact(llm.totals.inputTokens)} in · ${fmtCompact(llm.totals.outputTokens)} out`],
					['LLM games', fmtInt(llm.totals.games), `${fmtInt(llm.totals.calls)} model calls`],
					['Models', fmtInt(llm.models.length), 'self-reported usage']
				] as [l, v, sub] (l)}
					<div class="card p-4"><div class="label">{l}</div><div class="mt-1 text-3xl font-extrabold tracking-tight tabular-nums">{v}</div><div class="mt-0.5 text-xs text-ink-500">{sub}</div></div>
				{/each}
			</div>
			<div class="mt-3 grid gap-4 lg:grid-cols-2">
				<div class="card p-5" style="background: var(--surface-chart)">
					<h3 class="mb-3 font-semibold">Tokens per move <span class="font-normal text-ink-500">lower is cheaper</span></h3>
					<BarList title="Tokens per move by model" lowerIsBetter emptyLabel="no moves recorded" items={llm.models.slice(0, 8).map((m: Any) => ({ key: m.model, label: m.model.replace(/^.*\//, ''), value: m.tokensPerMove, color: 'var(--seq-400)', detail: `${m.model}\n${fmtInt(m.games)} games · ${fmtCompact(m.tokens.total)} tokens` }))} format={fmtCompact} />
				</div>
				<div class="card p-5" style="background: var(--surface-chart)">
					<h3 class="mb-3 font-semibold">Points per 1k tokens <span class="font-normal text-ink-500">efficiency</span></h3>
					<BarList title="Points per 1k tokens by model" items={llm.models.slice(0, 8).map((m: Any) => ({ key: m.model, label: m.model.replace(/^.*\//, ''), value: m.pointsPer1kTokens, color: 'var(--seq-400)', detail: `avg score ${fmtInt(m.avgScore)} · best tile ${fmtInt(m.bestTile)}` }))} format={(v) => v.toFixed(v < 10 ? 1 : 0)} />
				</div>
			</div>
			<div class="card mt-3 p-5">
				<DataTable
					caption="LLM usage by model"
					columns={[{ key: 'm', label: 'Model' }, { key: 'p', label: 'Provider' }, { key: 'g', label: 'Games', align: 'right' }, { key: 'c', label: 'Calls', align: 'right' }, { key: 'tok', label: 'Tokens', align: 'right' }, { key: 'cost', label: 'Cost', align: 'right' }, { key: 'cpg', label: 'Cost / game', align: 'right' }, { key: 'tpm', label: 'Tokens / move', align: 'right' }, { key: 's', label: 'Avg score', align: 'right' }, { key: 'ppd', label: 'Points / $', align: 'right' }]}
					rows={llm.models.map((m: Any) => ({ m: m.model, p: m.provider ?? '—', g: fmtInt(m.games), c: fmtInt(m.calls), tok: fmtCompact(m.tokens.total), cost: `${usd(m.costUsd)}${m.estimatedGames ? ' ≈' : ''}`, cpg: usd(m.costPerGameUsd), tpm: fmtCompact(m.tokensPerMove), s: fmtInt(m.avgScore), ppd: m.pointsPerDollar ? fmtCompact(m.pointsPerDollar) : m.costUsd === 0 ? '∞ (free)' : '—' }))}
				/>
			</div>
			<div class="card mt-3 overflow-hidden">
				<h3 class="px-4 pt-3 text-sm font-semibold">Recent LLM games</h3>
				<ul class="mt-1">
					{#each llm.recent as r (r.gameId)}
						<li>
							<a href={r.replayCode ? `/replay/${r.replayCode}` : undefined} class="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-ink-200/60 px-4 py-2 text-sm hover:bg-ink-900/[0.03] dark:border-white/5">
								<span class="font-medium">{r.model}</span>
								<span class="text-ink-500">{r.agentName ?? ''}</span>
								<span class="text-ink-500 tabular-nums">score {fmtInt(r.game?.score)} · {fmtInt(r.game?.moveNumber)} moves</span>
								<span class="ml-auto tabular-nums">{fmtCompact(r.tokens.total)} tokens · <b>{usd(r.costUsd)}</b>{r.costEstimated ? ' ≈' : ''}</span>
							</a>
						</li>
					{/each}
				</ul>
			</div>
			<p class="mt-2 text-xs text-ink-500">{llm.note} ≈ marks estimated cost.</p>
		{/if}
	{/if}
</section>

<!-- ======================================================== leaderboards -->
<section id="leaderboards" class="scroll-mt-28 pt-12">
	<h2 class="text-xl font-bold">Leaderboards</h2>
	{#if boards}
		<div class="mt-3 grid gap-4 md:grid-cols-3">
			{#each scoreBoards(boards) as board (board.title)}
				<div class="card overflow-hidden">
					<h3 class="px-4 pt-3 text-sm font-semibold">{board.title}</h3>
					<ol class="mt-1">
						{#each board.rows.slice(0, 8) as g, i (g.replayCode)}
							<li><a href="/replay/{g.replayCode}" class="flex items-center gap-2 border-t border-ink-200/60 px-4 py-1.5 text-sm hover:bg-ink-900/[0.03] dark:border-white/5"><span class="w-5 text-right text-ink-400">{i + 1}</span><span class="truncate">{g.player}</span><span class="ml-auto font-semibold tabular-nums">{board.value(g)}</span></a></li>
						{:else}<li class="px-4 py-3 text-sm text-ink-500">No games yet.</li>{/each}
					</ol>
				</div>
			{/each}
		</div>
		<div class="mt-4 grid gap-4 md:grid-cols-2">
			<div class="card p-4">
				<h3 class="text-sm font-semibold">Agent leaderboard</h3>
				<dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
					<dt class="text-ink-500">Best average</dt><dd>{boards.agents.bestAverage[0] ? `${boards.agents.bestAverage[0].name} · ${fmtInt(boards.agents.bestAverage[0].avgScore)}` : '—'}</dd>
					<dt class="text-ink-500">Best P99</dt><dd>{boards.agents.bestP99[0] ? `${boards.agents.bestP99[0].name} · ≈${fmtInt(boards.agents.bestP99[0].p99Score)}` : '— (needs 10 games)'}</dd>
					<dt class="text-ink-500">Highest tile</dt><dd>{boards.agents.highestTile[0] ? `${boards.agents.highestTile[0].name} · ${fmtInt(boards.agents.highestTile[0].highestTile)}` : '—'}</dd>
					<dt class="text-ink-500">Fastest decisions</dt><dd>{boards.agents.fastestDecision[0] ? `${boards.agents.fastestDecision[0].name} · ${fmtUs(boards.agents.fastestDecision[0].avgDecisionUs)}` : '—'}</dd>
				</dl>
			</div>
			<div class="card p-4">
				<h3 class="text-sm font-semibold">Runtime leaderboard <span class="font-normal text-ink-500">submitted runs</span></h3>
				<dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
					{#each runtimeRows(boards) as [l, v] (l)}
						<dt class="text-ink-500">{l}</dt>
						<dd>{v}</dd>
					{/each}
				</dl>
				<a class="mt-2 inline-block text-xs underline" href="/runtimes">Full runtime comparison →</a>
			</div>
		</div>
	{/if}
</section>

<!-- ============================================================= devices -->
<section id="devices" class="scroll-mt-28 pt-12 pb-8">
	<h2 class="text-xl font-bold">Audience <span class="text-base font-normal text-ink-500">last 30 days · aggregated</span></h2>
	{#if devices}
		{#if devices.sessions === 0}
			<p class="mt-3 text-sm text-ink-500">No sessions recorded yet.</p>
		{:else}
			<div class="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
				{#each [['Countries', devices.country], ['Device type', devices.device], ['Browser', devices.browser], ['OS', devices.os]] as [title, rows] (title)}
					<div class="card p-4" style="background: var(--surface-chart)">
						<h3 class="mb-3 text-sm font-semibold">{title}</h3>
						<BarList markBest={false} tickCount={2} title={String(title)} items={(rows as Any[]).slice(0, 6).map((r) => ({ key: r.value, label: r.value, value: r.share * 100, color: 'var(--seq-400)', detail: `${fmtInt(r.n)} sessions` }))} format={(v) => `${v.toFixed(0)}%`} />
					</div>
				{/each}
			</div>
		{/if}
		<p class="mt-2 text-xs text-ink-500">{devices.note}</p>
	{/if}
</section>
