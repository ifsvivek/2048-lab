<!--
  Horizontal bars, one per entity, with direct name + value labels (identity is
  never color-alone; values visible = contrast relief). Hover shows a tooltip
  with secondary facts. Zero baseline, 4px rounded data end, 2px gap.
-->
<script lang="ts">
	import { niceTicks } from './series';

	interface Item {
		key: string;
		label: string;
		value: number | null;
		color: string;
		detail?: string;
	}
	let {
		items,
		format,
		title,
		unit = '',
		lowerIsBetter = false,
		/** mark the best entity (comparisons); off for distributions */
		markBest = true,
		tickCount = 4
	}: { items: Item[]; format: (v: number) => string; title: string; unit?: string; lowerIsBetter?: boolean; markBest?: boolean; tickCount?: number } = $props();

	const max = $derived(Math.max(0, ...items.map((i) => i.value ?? 0)));
	const ticks = $derived(niceTicks(max, tickCount));
	const top = $derived(ticks[ticks.length - 1] || 1);
	const best = $derived.by(() => {
		const vals = items.filter((i) => i.value !== null && i.value > 0);
		if (!vals.length) return null;
		return vals.reduce((a, b) => ((lowerIsBetter ? b.value! < a.value! : b.value! > a.value!) ? b : a)).key;
	});
	let hover = $state<string | null>(null);
</script>

<figure class="w-full" aria-label={title}>
	<div class="space-y-2">
		{#each items as it (it.key)}
			<div
				class="group relative grid grid-cols-[6.5rem_1fr] items-center gap-3"
				role="img"
				aria-label="{it.label}: {it.value === null ? 'no data' : format(it.value)}{unit}"
				onpointerenter={() => (hover = it.key)}
				onpointerleave={() => (hover = null)}
			>
				<span class="truncate text-sm text-[var(--viz-text-2)]">{it.label}</span>
				<div class="relative h-7">
					<div class="absolute inset-y-0 left-0 flex w-full items-center">
						{#if it.value !== null}
							<div
								class="h-5 rounded-r-[4px] transition-[width] duration-500"
								style:width="{Math.max(0.4, (it.value / top) * 100)}%"
								style:background={it.color}
								style:opacity={hover && hover !== it.key ? 0.45 : 1}
							></div>
							<span class="ml-2 text-sm font-semibold whitespace-nowrap text-[var(--viz-text)] tabular-nums">
								{format(it.value)}{unit}
								{#if markBest && best === it.key && items.filter((i) => i.value !== null).length > 1}<span class="ml-1 text-[11px] font-medium text-[var(--viz-muted)]">{lowerIsBetter ? 'lowest' : 'best'}</span>{/if}
							</span>
						{:else}
							<span class="text-xs text-[var(--viz-muted)]">no run yet</span>
						{/if}
					</div>
				</div>
				{#if hover === it.key && it.detail}
					<div class="pointer-events-none absolute top-full left-28 z-10 mt-1 rounded-lg bg-ink-900 px-3 py-2 text-xs whitespace-pre text-white shadow-lg dark:bg-ink-100 dark:text-ink-900">{it.detail}</div>
				{/if}
			</div>
		{/each}
	</div>
	<div class="mt-1 grid grid-cols-[6.5rem_1fr] gap-3" aria-hidden="true">
		<span></span>
		<div class="relative h-4 border-t border-[var(--viz-grid)]">
			{#each ticks as t (t)}
				<span class="absolute pt-0.5 text-[10px] whitespace-nowrap text-[var(--viz-muted)] tabular-nums {t === 0 ? '' : t === top ? '-translate-x-full' : '-translate-x-1/2'}" style:left="{(t / top) * 100}%">{t === 0 ? '0' : format(t)}</span>
			{/each}
		</div>
	</div>
</figure>
