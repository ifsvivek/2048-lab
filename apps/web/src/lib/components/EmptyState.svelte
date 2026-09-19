<!-- Composed empty state: a mini board motif, a sentence of explanation, an optional action. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	let { title, children, action }: { title: string; children?: Snippet; action?: Snippet } = $props();
</script>

<div class="flex flex-col items-center px-6 py-12 text-center">
	<div class="grid grid-cols-3 gap-1.5 opacity-80" aria-hidden="true">
		{#each [0, 1, 0, 1, 2, 0, 0, 1, 0] as t, i (i)}
			<span class="h-4 w-4 rounded-[5px] {t === 2 ? 'bg-accent-400' : t === 1 ? 'bg-ink-300 dark:bg-ink-600' : 'bg-ink-900/[0.06] dark:bg-white/[0.06]'}"></span>
		{/each}
	</div>
	<p class="mt-5 font-medium">{title}</p>
	{#if children}<div class="mt-1 max-w-sm text-sm text-ink-500 dark:text-ink-400">{@render children()}</div>{/if}
	{#if action}<div class="mt-5">{@render action()}</div>{/if}
</div>
