<!-- Single-series vertical columns (e.g. max-tile distribution). One hue; values labelled; hover tooltip. -->
<script lang="ts">
	let { data, title, color = 'var(--seq-400)', format = (v: number) => String(v) }: { data: { label: string; value: number; note?: string }[]; title: string; color?: string; format?: (v: number) => string } = $props();
	const max = $derived(Math.max(1, ...data.map((d) => d.value)));
	let hover = $state<number | null>(null);
</script>

<figure aria-label={title} class="w-full">
	<div class="flex h-40 items-end gap-[2px]">
		{#each data as d, i (d.label)}
			<div class="relative flex h-full flex-1 flex-col justify-end" role="img" aria-label="{d.label}: {format(d.value)}" onpointerenter={() => (hover = i)} onpointerleave={() => (hover = null)}>
				{#if d.value > 0}<span class="mb-1 text-center text-[10px] font-semibold text-[var(--viz-text-2)] tabular-nums">{format(d.value)}</span>{/if}
				<div class="rounded-t-[4px] transition-[height] duration-500" style:height="{(d.value / max) * 82}%" style:background={color} style:opacity={hover !== null && hover !== i ? 0.5 : 1}></div>
				{#if hover === i && d.note}
					<div class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-lg bg-ink-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white dark:bg-ink-100 dark:text-ink-900">{d.note}</div>
				{/if}
			</div>
		{/each}
	</div>
	<div class="mt-1 flex gap-[2px] border-t border-[var(--viz-grid)] pt-1">
		{#each data as d (d.label)}<span class="flex-1 truncate text-center text-[10px] text-[var(--viz-muted)]">{d.label}</span>{/each}
	</div>
</figure>
