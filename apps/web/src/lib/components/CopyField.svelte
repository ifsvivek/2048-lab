<script lang="ts">
	let { label, value, mono = true, href }: { label: string; value: string; mono?: boolean; href?: string } = $props();
	let copied = $state(false);
	async function copy() {
		await navigator.clipboard.writeText(href ?? value);
		copied = true;
		setTimeout(() => (copied = false), 1400);
	}
</script>

<div class="min-w-0">
	<div class="label mb-1">{label}</div>
	<button type="button" onclick={copy} class="group flex w-full min-w-0 items-center gap-2 rounded-lg bg-ink-900/[0.04] px-2.5 py-1.5 text-left transition-colors hover:bg-ink-900/[0.08] dark:bg-white/5 dark:hover:bg-white/10" aria-label="Copy {label}: {value}">
		<span class="truncate text-sm font-medium" class:mono>{value}</span>
		<span class="ml-auto shrink-0 text-[11px] text-ink-500 dark:text-ink-400" aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
	</button>
</div>
