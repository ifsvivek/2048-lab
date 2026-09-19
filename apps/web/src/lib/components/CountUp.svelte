<!-- A number that counts up the first time it scrolls into view (rare, meaningful → worth animating). -->
<script lang="ts">
	import { onVisible, tween } from '$lib/motion';
	let { value, format = (v: number) => Math.round(v).toLocaleString('en-US') }: { value: number | null | undefined; format?: (v: number) => string } = $props();
	let shown = $state(0);
	let seen = $state(false);
	let stop: () => void = () => {};
	$effect(() => {
		const v = value ?? 0;
		if (!seen) return;
		stop();
		stop = tween(shown, v, (x) => (shown = x));
		return () => stop();
	});
</script>

<span class="tabular-nums" use:onVisible={() => (seen = true)}>{value === null || value === undefined ? '—' : format(seen ? shown : 0)}</span>
