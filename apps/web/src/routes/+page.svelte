<script lang="ts">
	import { goto } from '$app/navigation';
	import { type Direction, DIRECTION_NAMES, Game, boardToHex, classifyGameRef, maxTile, move } from '@g2048/engine';
	import { onDestroy, onMount } from 'svelte';
	import Board, { type BoardStep } from '$lib/components/Board.svelte';
	import CountUp from '$lib/components/CountUp.svelte';
	import { AiWorker } from '$lib/ai/client';
	import { api } from '$lib/api';
	import { BASELINE } from '$lib/bench-data';
	import { langColor } from '$lib/charts/series';
	import { API_URL, MCP_URL } from '$lib/config';
	import { LANG_LABEL, fmtCompact, fmtUs } from '$lib/format';
	import { onVisible, reducedMotion, reveal } from '$lib/motion';
	import { createLocalGame } from '$lib/newgame';

	// ------------------------------------------------------------ actions
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
			refError = 'That doesn’t look like a replay code (A7KF-29LM-XQ4P) or a game ID.';
			return;
		}
		goto(`/replay/${encodeURIComponent(c.value)}`);
	}

	// ------------------------------------------- live agent in the hero
	let board = $state(new Uint8Array(16));
	let step = $state<BoardStep | null>(null);
	let score = $state(0);
	let moves = $state(0);
	let decision = $state<{ move: Direction; depth?: number; nodes?: number; timeUs: number } | null>(null);
	let heroVisible = true;
	let running = true;
	let ai: AiWorker | null = null;
	let game: Game;

	async function loop() {
		if (!running) return;
		if (!game || game.over) {
			game = new Game((Math.random() * 2 ** 32) >>> 0);
			board = game.board.slice();
			step = null;
		}
		if (heroVisible && document.visibilityState === 'visible') {
			ai ??= new AiWorker();
			try {
				const d = await ai.decide({ boardHex: boardToHex(game.board), seed: game.seed, score: game.score, moveCount: game.moveCount, agent: 'expectimax', config: { depth: 'auto', maxDepth: 3 } });
				const prev = game.board.slice();
				const r = game.apply(d.move);
				if (r) {
					step = { prev, dir: d.move, spawn: r.spawn };
					board = game.board.slice();
					score = game.score;
					moves = game.moveCount;
					decision = { move: d.move, depth: d.metrics.depth, nodes: d.metrics.nodes, timeUs: d.metrics.timeUs };
				}
			} catch {
				/* worker restarted */
			}
		}
		setTimeout(loop, reducedMotion() ? 900 : 260);
	}

	// ---------------------------------------------------- live platform
	let stats = $state<{ games: number; moves: number; runs: number; tokens: number } | null>(null);
	let impact = $state<{ energyKwh: number; phoneCharges: number; tokens: number; costUsd: number } | null>(null);

	// ------------------------------------------------------ runtime race
	const race = ['rust', 'go', 'typescript', 'python'].map((l) => {
		const r = BASELINE.find((x) => x.suiteId === 'engine-random-10k' && x.language === l)!;
		return { lang: l, mps: r?.movesPerSec ?? 0, checksum: r?.checksum ?? '' };
	});
	const fastest = Math.max(...race.map((r) => r.mps));
	let raceGo = $state(false);

	// --------------------------------------------- replay timeline demo
	let curve = $state<{ path: string; area: string; marks: { x: number; y: number; t: number }[] } | null>(null);
	let drawn = $state(false);
	function buildCurve() {
		// A deterministic game (seed 2048) played by a fast one-ply agent — same result on every device.
		const g = new Game(2048);
		const pts: number[] = [0];
		const firsts: { m: number; t: number }[] = [];
		let best = 0;
		const order: Direction[] = [1, 2, 3, 0];
		while (!g.over && g.moveCount < 1400) {
			let bestD: Direction = 1;
			let bestE = -1;
			for (const d of order) {
				const r = move(g.board, d);
				if (!r.changed) continue;
				let e = 0;
				for (let i = 0; i < 16; i++) if (!r.board[i]) e++;
				if (e > bestE) {
					bestE = e;
					bestD = d;
				}
			}
			g.apply(bestD);
			pts.push(g.score);
			const mt = maxTile(g.board);
			if (mt > best && mt >= 128) firsts.push({ m: g.moveCount, t: mt });
			best = Math.max(best, mt);
		}
		const W = 600;
		const H = 120;
		const max = pts[pts.length - 1] || 1;
		const xy = (i: number, v: number) => [(i / (pts.length - 1)) * W, H - (v / max) * (H - 8)];
		const path = pts.map((v, i) => (i % 3 === 0 || i === pts.length - 1 ? `${i ? 'L' : 'M'}${xy(i, v).map((n) => n.toFixed(1)).join(',')}` : '')).join('');
		curve = { path, area: `${path}L${W},${H}L0,${H}Z`, marks: firsts.map((f) => ({ x: xy(f.m, pts[f.m])[0], y: xy(f.m, pts[f.m])[1], t: f.t })) };
	}

	// ------------------------------------------------------ integrations
	let tab = $state<'mcp' | 'rest' | 'python'>('mcp');
	const snippets = $derived({
		mcp: `claude mcp add --transport http g2048 \\\n  ${MCP_URL}\n\n# then: "play a game of 2048 and report your token usage"`,
		rest: `curl -X POST ${API_URL}/v1/games -d '{"seed":42}'\n# → { gameId, board, validMoves, ... }\n\ncurl -X POST ${API_URL}/v1/games/$ID/moves \\\n  -d '{"move":"left"}'`,
		python: `from g2048.client import PlatformClient\n\napi = PlatformClient("${API_URL}")\ns = api.create_game(seed=42)\nwhile s["status"] == "active":\n    s = api.move(s["gameId"], pick(s["board"], s["validMoves"]))`
	});
	let copied = $state(false);
	async function copy() {
		await navigator.clipboard.writeText(snippets[tab]);
		copied = true;
		setTimeout(() => (copied = false), 1400);
	}

	let heroEl: HTMLElement;
	onMount(() => {
		const io = new IntersectionObserver(([e]) => (heroVisible = e.isIntersecting));
		io.observe(heroEl);
		loop();
		api<any>('/v1/analytics/overview')
			.then((o) => (stats = { games: o.totals.games, moves: o.totals.totalMoves, runs: o.totals.benchmarkRuns, tokens: 0 }))
			.catch(() => {});
		api<any>('/v1/analytics/impact')
			.then((i) => (impact = { energyKwh: i.footprint.energyKwh, phoneCharges: i.footprint.phoneCharges, tokens: i.totals.llmTokens, costUsd: i.totals.estimatedCostUsd }))
			.catch(() => {});
		return () => io.disconnect();
	});
	onDestroy(() => {
		running = false;
		ai?.terminate();
	});
</script>

<svelte:head><title>2048 Lab: AI experimentation & benchmarking for 2048</title></svelte:head>

<!-- ================================================================ hero -->
<section bind:this={heroEl} class="relative grid items-center gap-12 pt-2 pb-16 lg:grid-cols-[1.05fr_1fr] lg:pt-8">
	<div aria-hidden="true" class="pointer-events-none absolute -top-40 right-[-10%] -z-10 h-[520px] w-[620px] rounded-full bg-[radial-gradient(closest-side,rgb(236_154_44/0.20),transparent)] blur-2xl dark:bg-[radial-gradient(closest-side,rgb(236_154_44/0.14),transparent)]"></div>

	<div>
		<p class="eyebrow" use:reveal={0}>AI experimentation · benchmarks · replays</p>
		<h1 class="mt-4 text-[clamp(2.6rem,6vw,4.6rem)] leading-[0.98] font-semibold tracking-[-0.035em]" use:reveal={1}>
			A lab for<br />2048 agents<span class="text-accent-500">.</span>
		</h1>
		<p class="mt-5 max-w-[34rem] text-lg leading-relaxed text-ink-600 dark:text-ink-300" use:reveal={2}>
			Play, or let an AI play. Replay any game from a short code, and race four language implementations that produce <em class="not-italic whitespace-nowrap text-ink-900 dark:text-white">bit‑identical games</em>.
		</p>

		<div class="mt-8 flex max-w-md flex-col gap-3" use:reveal={3}>
			<button class="btn-primary h-13 text-[15px]" onclick={start} disabled={starting}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" /></svg>
				Start New Game
			</button>
			<form class="flex gap-2 rounded-2xl bg-(--surface) p-1.5 shadow-[0_0_0_1px_var(--hairline)] transition-shadow focus-within:shadow-[0_0_0_1px_var(--hairline),0_0_0_4px_rgb(236_154_44/0.18)]" onsubmit={openReplay}>
				<label for="ref" class="sr-only">Replay code or game ID</label>
				<input id="ref" class="min-w-0 flex-1 bg-transparent px-3 font-mono text-sm tracking-wider uppercase outline-none placeholder:font-sans placeholder:tracking-normal placeholder:normal-case" placeholder="Replay code, e.g. A7KF-29LM-XQ4P" bind:value={ref} oninput={() => (refError = '')} autocomplete="off" spellcheck="false" aria-describedby={refError ? 'ref-err' : undefined} />
				<button class="btn-ghost h-10 shrink-0" type="submit">Open Replay</button>
			</form>
			{#if refError}<p id="ref-err" class="text-sm text-red-600 dark:text-red-400" role="alert">{refError}</p>{/if}
		</div>

		<dl class="mt-10 grid max-w-md grid-cols-3 gap-6" use:reveal={4}>
			<div><dt class="label">Games played</dt><dd class="mt-1 text-2xl font-semibold tracking-tight">{#if stats}<CountUp value={stats.games} />{:else}<span class="skeleton inline-block h-7 w-16 align-middle"></span>{/if}</dd></div>
			<div><dt class="label">Moves recorded</dt><dd class="mt-1 text-2xl font-semibold tracking-tight">{#if stats}<CountUp value={stats.moves} format={fmtCompact} />{:else}<span class="skeleton inline-block h-7 w-16 align-middle"></span>{/if}</dd></div>
			<div><dt class="label">Benchmark runs</dt><dd class="mt-1 text-2xl font-semibold tracking-tight">{#if stats}<CountUp value={stats.runs} />{:else}<span class="skeleton inline-block h-7 w-12 align-middle"></span>{/if}</dd></div>
		</dl>
	</div>

	<!-- live agent -->
	<div class="relative mx-auto w-full max-w-[440px]" use:reveal={2}>
		<div class="card p-3 sm:p-4">
			<div class="mb-3 flex items-center justify-between px-1">
				<div class="flex items-center gap-2 text-sm font-medium">
					<span class="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true"></span>
					Expectimax · playing live
				</div>
				<div class="font-mono text-xs text-ink-500 tabular-nums">score {score.toLocaleString('en-US')} · move {moves}</div>
			</div>
			<Board {board} {step} label="Live AI demo board" />
			<div class="mt-3 grid grid-cols-4 gap-2 px-1 text-center" aria-live="off">
				<div class="well py-2"><div class="label">Move</div><div class="font-mono text-sm font-medium capitalize">{decision ? DIRECTION_NAMES[decision.move] : '—'}</div></div>
				<div class="well py-2"><div class="label">Depth</div><div class="font-mono text-sm font-medium">{decision?.depth ?? '—'}</div></div>
				<div class="well py-2"><div class="label">Nodes</div><div class="font-mono text-sm font-medium">{fmtCompact(decision?.nodes)}</div></div>
				<div class="well py-2"><div class="label">Think</div><div class="font-mono text-sm font-medium">{fmtUs(decision?.timeUs)}</div></div>
			</div>
		</div>
		<p class="mt-3 text-center text-xs text-ink-500">Running in your browser (Web Worker) · <a class="btn-link text-xs" href="/watch">watch more agents →</a></p>
	</div>
</section>

<!-- ======================================================== runtime race -->
<section class="border-t border-(--hairline) py-20">
	<div class="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
		<div use:reveal={0}>
			<p class="eyebrow">Cross-language benchmarking</p>
			<h2 class="mt-3 text-3xl font-semibold sm:text-4xl">Same game.<br />Four languages.</h2>
			<p class="mt-4 max-w-md text-ink-600 dark:text-ink-300">
				TypeScript, Rust, Go and Python follow one spec. They play exactly the same 10,000 games and agree on every board to the bit. Only speed differs.
			</p>
			<a class="btn-link mt-6" href="/runtimes">Open the runtime dashboard →</a>
		</div>
		<div class="card p-6 sm:p-8" use:onVisible={() => (raceGo = true)} use:reveal={1}>
			<div class="mb-6 flex items-baseline justify-between">
				<span class="text-sm font-medium">Moves simulated per second</span>
				<span class="hidden font-mono text-xs text-ink-500 sm:inline">engine-random-10k</span>
			</div>
			<ol class="space-y-5">
				{#each race as r, i (r.lang)}
					<li>
						<div class="mb-1.5 flex items-baseline justify-between text-sm">
							<span class="font-medium">{LANG_LABEL[r.lang]}</span>
							<span class="font-mono tabular-nums">{#if raceGo}<CountUp value={r.mps} format={fmtCompact} />{:else}0{/if}<span class="text-ink-500">/s</span></span>
						</div>
						<div class="h-2.5 overflow-hidden rounded-full bg-ink-900/[0.06] dark:bg-white/[0.06]">
							<div
								class="h-full origin-left rounded-full transition-transform duration-[1400ms] ease-(--ease-out-expo)"
								style:background={langColor(r.lang)}
								style:transform="scaleX({raceGo ? Math.max(0.012, r.mps / fastest) : 0})"
								style:transition-delay="{i * 90}ms"
							></div>
						</div>
						<div class="mt-1 font-mono text-[11px] text-ink-500">checksum {r.checksum} <span class="text-emerald-600 dark:text-emerald-400">✓ identical</span></div>
					</li>
				{/each}
			</ol>
		</div>
	</div>
</section>

<!-- ======================================================= replays story -->
<section class="border-t border-(--hairline) py-20">
	<div class="grid items-center gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:gap-16">
		<div class="order-2 lg:order-1" use:reveal={1} use:onVisible={() => { buildCurve(); requestAnimationFrame(() => requestAnimationFrame(() => (drawn = true))); }}>
			<div class="card p-6">
				<div class="mb-4 flex items-center justify-between">
					<span class="font-mono text-sm tracking-wider">SEED 2048</span>
					<span class="text-xs text-ink-500">score over moves · milestones marked</span>
				</div>
				<svg viewBox="0 0 600 120" class="h-40 w-full overflow-visible" role="img" aria-label="Score over the course of a replayed game">
					{#if curve}
						<path d={curve.area} fill="rgb(236 154 44 / 0.10)" class="transition-opacity delay-700 duration-700" style:opacity={drawn ? 1 : 0} />
						<path d={curve.path} fill="none" stroke="var(--color-accent-500)" stroke-width="2" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" style:stroke-dashoffset={drawn ? 0 : 1} style:transition="stroke-dashoffset 1600ms var(--ease-out-expo)" />
						{#each curve.marks as m, i (i)}
							<g class="transition-opacity duration-500" style:opacity={drawn ? 1 : 0} style:transition-delay="{800 + i * 120}ms">
								<circle cx={m.x} cy={m.y} r="4" fill="var(--surface)" stroke="var(--color-accent-500)" stroke-width="2" />
								<text x={m.x} y={m.y - 10} text-anchor="middle" font-size="11" class="fill-ink-600 font-mono dark:fill-ink-300">{m.t}</text>
							</g>
						{/each}
					{/if}
				</svg>
			</div>
		</div>
		<div class="order-1 lg:order-2" use:reveal={0}>
			<p class="eyebrow">Deterministic replays</p>
			<h2 class="mt-3 text-3xl font-semibold sm:text-4xl">Every game is a replay.</h2>
			<p class="mt-4 max-w-md text-ink-600 dark:text-ink-300">
				A game is just a seed and a list of moves. Share a 12-character code and anyone can scrub through it move by move. Their browser rebuilds the game and checks it against the stored hash.
			</p>
			<a class="btn-link mt-6" href="/replay">Browse replays →</a>
		</div>
	</div>
</section>

<!-- ======================================================== integrations -->
<section class="border-t border-(--hairline) py-20">
	<div class="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
		<div use:reveal={0}>
			<p class="eyebrow">Bring your own agent</p>
			<h2 class="mt-3 text-3xl font-semibold sm:text-4xl">Plug in anything that can pick a move.</h2>
			<ul class="mt-6 space-y-3 text-ink-600 dark:text-ink-300">
				<li class="flex gap-3"><span class="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500"></span><span><b class="font-medium text-ink-900 dark:text-white">MCP</b>: Claude Code, Codex, Cursor and others play through tools.</span></li>
				<li class="flex gap-3"><span class="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500"></span><span><b class="font-medium text-ink-900 dark:text-white">REST</b>: every response is the full state for the next decision.</span></li>
				<li class="flex gap-3"><span class="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500"></span><span><b class="font-medium text-ink-900 dark:text-white">Webhooks</b>: the platform calls your agent, and spectators watch live.</span></li>
			</ul>
			<a class="btn-link mt-6" href="/agents">Connect an agent →</a>
		</div>
		<div use:reveal={1}>
			<div class="overflow-hidden rounded-2xl bg-ink-950 shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_24px_48px_-24px_rgb(0_0_0/0.5)]">
				<div class="flex items-center gap-1 border-b border-white/[0.06] px-3 pt-3" role="tablist" aria-label="Integration example">
					{#each [['mcp', 'MCP'], ['rest', 'REST'], ['python', 'Python']] as [k, l] (k)}
						<button role="tab" aria-selected={tab === k} class="relative rounded-t-lg px-3 pb-2.5 pt-1.5 text-sm text-ink-400 transition-colors hover:text-ink-100 aria-selected:text-white" onclick={() => (tab = k as typeof tab)}>
							{l}{#if tab === k}<span class="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-accent-400"></span>{/if}
						</button>
					{/each}
					<button class="ml-auto mb-2 rounded-md px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-white/5 hover:text-white" onclick={copy} aria-live="polite">{copied ? 'Copied' : 'Copy'}</button>
				</div>
				<pre class="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-ink-100"><code>{snippets[tab]}</code></pre>
			</div>
		</div>
	</div>
</section>

<!-- ============================================================= impact -->
<section class="border-t border-(--hairline) py-20">
	<div class="card relative overflow-hidden p-8 sm:p-12" use:reveal={0}>
		<div aria-hidden="true" class="pointer-events-none absolute -right-20 -bottom-24 h-72 w-72 rounded-full bg-[radial-gradient(closest-side,rgb(25_158_112/0.16),transparent)]"></div>
		<div class="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-end">
			<div>
				<p class="eyebrow">The cost of intelligence</p>
				<h2 class="mt-3 text-3xl font-semibold sm:text-4xl">What does running AI actually cost?</h2>
				<p class="mt-4 max-w-md text-ink-600 dark:text-ink-300">
					A tree-search agent decides a move in microseconds. An LLM agent can burn a thousand tokens on the same move. We estimate the money, energy, water and carbon involved.
				</p>
				<a class="btn-link mt-6" href="/analytics#impact">See the impact dashboard →</a>
			</div>
			<dl class="grid grid-cols-2 gap-4">
				<div class="well p-4"><dt class="label">Estimated energy</dt><dd class="mt-1 text-2xl font-semibold tracking-tight">{#if impact}<CountUp value={impact.energyKwh * 1000} format={(v) => `${v < 10 ? v.toFixed(2) : Math.round(v)} Wh`} />{:else}—{/if}</dd></div>
				<div class="well p-4"><dt class="label">≈ phone charges</dt><dd class="mt-1 text-2xl font-semibold tracking-tight">{#if impact}<CountUp value={impact.phoneCharges} format={(v) => v.toFixed(v < 10 ? 1 : 0)} />{:else}—{/if}</dd></div>
				<div class="well p-4"><dt class="label">LLM tokens</dt><dd class="mt-1 text-2xl font-semibold tracking-tight">{#if impact}<CountUp value={impact.tokens} format={fmtCompact} />{:else}—{/if}</dd></div>
				<div class="well p-4"><dt class="label">Estimated spend</dt><dd class="mt-1 text-2xl font-semibold tracking-tight">{#if impact}<CountUp value={impact.costUsd} format={(v) => `$${v.toFixed(v < 1 ? 4 : 2)}`} />{:else}—{/if}</dd></div>
			</dl>
		</div>
	</div>
</section>

<!-- ================================================================ cta -->
<section class="py-16 text-center" use:reveal={0}>
	<h2 class="text-3xl font-semibold sm:text-4xl">Your move.</h2>
	<div class="mt-6 flex flex-wrap justify-center gap-3">
		<button class="btn-primary" onclick={start} disabled={starting}>Start New Game</button>
		<a class="btn-ghost" href="/watch">Watch the AI</a>
	</div>
</section>
