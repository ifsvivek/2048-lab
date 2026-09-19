<!--
  Multi-series line chart: 2px lines, one y-axis, recessive grid, legend on top
  plus direct end labels (≤4 series), crosshair + tooltip on hover.
-->
<script lang="ts">
	import { niceTicks } from './series';

	interface Series {
		key: string;
		label: string;
		color: string;
		points: { x: number; y: number }[];
	}
	let { series, formatY, formatX, title, height = 220 }: { series: Series[]; formatY: (v: number) => string; formatX: (v: number) => string; title: string; height?: number } = $props();

	const W = 640;
	const pad = { l: 48, r: 92, t: 12, b: 26 };
	const all = $derived(series.flatMap((s) => s.points));
	const xmin = $derived(Math.min(...all.map((p) => p.x)));
	const xmax = $derived(Math.max(...all.map((p) => p.x)));
	const ticks = $derived(niceTicks(Math.max(...all.map((p) => p.y), 0)));
	const ytop = $derived(ticks[ticks.length - 1] || 1);
	const sx = (x: number) => pad.l + (xmax === xmin ? (W - pad.l - pad.r) / 2 : ((x - xmin) / (xmax - xmin)) * (W - pad.l - pad.r));
	const sy = (y: number) => pad.t + (1 - y / ytop) * (height - pad.t - pad.b);
	const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');

	let hoverX = $state<number | null>(null);
	const xs = $derived([...new Set(all.map((p) => p.x))].sort((a, b) => a - b));
	function onMove(e: PointerEvent) {
		const svg = e.currentTarget as SVGSVGElement;
		const r = svg.getBoundingClientRect();
		const px = ((e.clientX - r.left) / r.width) * W;
		let best = xs[0];
		for (const x of xs) if (Math.abs(sx(x) - px) < Math.abs(sx(best) - px)) best = x;
		hoverX = best ?? null;
	}
	const at = (s: Series, x: number) => s.points.find((p) => p.x === x);
</script>

<figure class="w-full" aria-label={title}>
	{#if series.length > 1}
		<div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--viz-text-2)]">
			{#each series as s (s.key)}
				<span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-3.5 rounded" style:background={s.color}></span>{s.label}</span>
			{/each}
		</div>
	{/if}
	{#if all.length === 0}
		<p class="py-10 text-center text-sm text-[var(--viz-muted)]">No data yet.</p>
	{:else}
		<div class="relative">
			<svg viewBox="0 0 {W} {height}" class="w-full overflow-visible" role="img" aria-label={title} onpointermove={onMove} onpointerleave={() => (hoverX = null)}>
				{#each ticks as t (t)}
					<line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--viz-grid)" stroke-width="1" />
					<text x={pad.l - 8} y={sy(t) + 3.5} text-anchor="end" font-size="10" fill="var(--viz-muted)">{formatY(t)}</text>
				{/each}
				<text x={pad.l} y={height - 6} font-size="10" fill="var(--viz-muted)">{formatX(xmin)}</text>
				<text x={W - pad.r} y={height - 6} font-size="10" text-anchor="end" fill="var(--viz-muted)">{formatX(xmax)}</text>
				{#if hoverX !== null}
					<line x1={sx(hoverX)} x2={sx(hoverX)} y1={pad.t} y2={height - pad.b} stroke="var(--viz-muted)" stroke-dasharray="3 3" />
				{/if}
				{#each series as s (s.key)}
					{@const pts = [...s.points].sort((a, b) => a.x - b.x)}
					<path d={path(pts)} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
					{#each pts as p (p.x)}
						{#if pts.length < 30 || (hoverX === p.x)}
							<circle cx={sx(p.x)} cy={sy(p.y)} r={hoverX === p.x ? 4.5 : 3} fill={s.color} stroke="var(--surface-chart)" stroke-width="2" />
						{/if}
					{/each}
					{#if pts.length && series.length <= 4}
						{@const last = pts[pts.length - 1]}
						<text x={sx(last.x) + 8} y={sy(last.y) + 3.5} font-size="11" fill="var(--viz-text-2)">{s.label}</text>
					{/if}
				{/each}
			</svg>
			{#if hoverX !== null}
				<div class="pointer-events-none absolute top-2 z-10 rounded-lg bg-ink-900 px-3 py-2 text-xs text-white shadow-lg dark:bg-ink-100 dark:text-ink-900" style:left="{Math.min(70, (sx(hoverX) / W) * 100)}%">
					<div class="mb-1 font-semibold">{formatX(hoverX)}</div>
					{#each series as s (s.key)}
						{@const p = at(s, hoverX)}
						{#if p}<div class="flex items-center gap-2"><span class="h-2 w-2 rounded-full" style:background={s.color}></span>{s.label}<span class="ml-auto pl-3 tabular-nums">{formatY(p.y)}</span></div>{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</figure>
