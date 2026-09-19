<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { createLocalGame } from '$lib/newgame';

	// /play → start a fresh local game (optionally ?seed=123) and redirect to it.
	onMount(async () => {
		const s = page.url.searchParams.get('seed');
		const seed = s !== null && /^\d+$/.test(s) && Number(s) <= 0xffffffff ? Number(s) : undefined;
		const g = await createLocalGame({ seed });
		goto(`/play/${g.id}${page.url.searchParams.get('ai') ? '?ai=1' : ''}`, { replaceState: true });
	});
</script>

<p class="py-20 text-center text-ink-500">Creating game…</p>
