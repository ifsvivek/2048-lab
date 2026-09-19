<script lang="ts">
	import { page } from '$app/state';
	import EmptyState from '$lib/components/EmptyState.svelte';
</script>

<svelte:head><title>{page.status} · 2048 Lab</title></svelte:head>

<div class="grid min-h-[60dvh] place-items-center">
	<div class="text-center">
		<p class="eyebrow">Error {page.status}</p>
		<EmptyState title={page.status === 404 ? 'No tile here.' : 'Something went wrong.'}>
			{page.status === 404 ? "This page doesn't exist. The board you're after might be a replay: paste its code on the replays page." : page.error?.message}
			{#snippet action()}
				<div class="flex gap-2"><a class="btn-primary" href="/">Back to the lab</a><a class="btn-ghost" href="/replay">Open a replay</a></div>
			{/snippet}
		</EmptyState>
	</div>
</div>
