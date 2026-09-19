<!-- Explains an expectimax decision: per-direction expected values, search stats, heuristic terms. -->
<script lang="ts">
	import { DIRECTION_NAMES } from '@g2048/engine';
	import type { DecisionMetrics } from '@g2048/engine/ai';
	import { fmtCompact, fmtInt } from '$lib/format';

	let { metrics, move }: { metrics: DecisionMetrics | null; move: number | null } = $props();
	const vals = $derived(metrics?.values ?? null);
	const finite = $derived((vals ?? []).filter((v): v is number => v !== null));
	const lo = $derived(finite.length ? Math.min(...finite) : 0);
	const hi = $derived(finite.length ? Math.max(...finite) : 1);
</script>

{#if !metrics}
	<p class="mt-4 text-sm text-ink-500">Start the AI or ask for a hint to see its reasoning.</p>
{:else}
	<div class="mt-4 space-y-3">
		{#if vals}
			<div>
				<div class="label mb-1.5">Expected value by move <span class="normal-case tracking-normal">(gap to best)</span></div>
				<div class="space-y-1">
					{#each vals as v, d (d)}
						<div class="grid grid-cols-[3.5rem_1fr_4.5rem] items-center gap-2 text-sm">
							<span class:font-semibold={d === move}>{DIRECTION_NAMES[d]}</span>
							<div class="h-2.5 rounded-r-[4px] bg-ink-900/[0.05] dark:bg-white/5">
								{#if v !== null}
									<div class="h-full rounded-r-[4px]" style:width="{hi === lo ? 100 : 12 + ((v - lo) / (hi - lo)) * 88}%" style:background={d === move ? 'var(--color-accent-500)' : 'var(--viz-muted)'}></div>
								{/if}
							</div>
							<span class="text-right text-xs tabular-nums text-ink-500">{v === null ? 'invalid' : v === hi ? 'best' : `−${fmtCompact(hi - v)}`}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		<dl class="grid grid-cols-4 gap-2 text-center">
			<div><dt class="label">Depth</dt><dd class="font-semibold tabular-nums">{metrics.depth ?? '-'}</dd></div>
			<div><dt class="label">Nodes</dt><dd class="font-semibold tabular-nums">{fmtCompact(metrics.nodes)}</dd></div>
			<div><dt class="label">TT hits</dt><dd class="font-semibold tabular-nums">{fmtCompact(metrics.ttHits)}</dd></div>
			<div><dt class="label">TT size</dt><dd class="font-semibold tabular-nums">{fmtCompact(metrics.ttSize)}</dd></div>
		</dl>
		{#if metrics.heuristic}
			{@const h = metrics.heuristic}
			<details class="text-sm">
				<summary class="cursor-pointer text-ink-600 dark:text-ink-300">Board evaluation {fmtCompact(h.total)}</summary>
				<dl class="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
					<dt>Empty cells</dt><dd class="col-span-2 tabular-nums">{fmtInt(h.empty)} (across rows+cols)</dd>
					<dt>Merge chances</dt><dd class="col-span-2 tabular-nums">{fmtInt(h.merges)}</dd>
					<dt>Monotonicity penalty</dt><dd class="col-span-2 tabular-nums">{fmtCompact(h.mono)}</dd>
					<dt>Tile-sum penalty</dt><dd class="col-span-2 tabular-nums">{fmtCompact(h.sum)}</dd>
					<dt>Smoothness</dt><dd class="col-span-2 tabular-nums">{fmtInt(h.smooth)}</dd>
					<dt>Stable full lines</dt><dd class="col-span-2 tabular-nums">{fmtInt(h.stable)}</dd>
					<dt>Corner bonus</dt><dd class="col-span-2 tabular-nums">{fmtInt(h.corner)}</dd>
				</dl>
			</details>
		{/if}
	</div>
{/if}
