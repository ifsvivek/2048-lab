<script lang="ts">
	let { columns, rows, caption }: { columns: { key: string; label: string; align?: 'right' }[]; rows: Record<string, string | number>[]; caption: string } = $props();
</script>

<div class="overflow-x-auto">
	<table class="w-full text-sm">
		<caption class="sr-only">{caption}</caption>
		<thead>
			<tr class="border-b border-[var(--viz-grid)] text-left">
				{#each columns as c (c.key)}<th scope="col" class="py-2 pr-4 font-medium text-[var(--viz-text-2)]" class:text-right={c.align === 'right'}>{c.label}</th>{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as r, i (i)}
				<tr class="border-b border-[var(--viz-grid)]/60">
					{#each columns as c (c.key)}<td class="py-2 pr-4 tabular-nums" class:text-right={c.align === 'right'}>{r[c.key]}</td>{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>
