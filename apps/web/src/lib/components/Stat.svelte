<script lang="ts">
	let { label, value, sub }: { label: string; value: string | number; sub?: string } = $props();
</script>

<div class="rounded-xl bg-ink-900/[0.04] px-3 py-2 dark:bg-white/5">
	<div class="label">{label}</div>
	<div class="text-xl font-bold tracking-tight tabular-nums">{value}</div>
	{#if sub}<div class="text-[11px] text-ink-500 dark:text-ink-400">{sub}</div>{/if}
</div>
