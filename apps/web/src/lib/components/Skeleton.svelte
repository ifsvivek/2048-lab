<!-- Layout-shaped placeholder while data loads. -->
<script lang="ts">
	let { rows = 3, class: cls = '' }: { rows?: number; class?: string } = $props();
</script>

<div class="space-y-2.5 {cls}" aria-busy="true" aria-label="Loading">
	{#each Array(rows) as _, i (i)}
		<div class="skeleton h-4" style:width="{[92, 74, 86, 61, 80][i % 5]}%"></div>
	{/each}
</div>
