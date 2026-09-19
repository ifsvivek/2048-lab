<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { flushPending } from '$lib/sync';
	import { online, theme } from '$lib/theme.svelte';

	let { children } = $props();

	const NAV = [
		{ href: '/play', label: 'Play' },
		{ href: '/replay', label: 'Replay' },
		{ href: '/watch', label: 'Watch AI' },
		{ href: '/benchmarks', label: 'Benchmarks' },
		{ href: '/runtimes', label: 'Runtimes' },
		{ href: '/leaderboard', label: 'Leaderboard' },
		{ href: '/agents', label: 'Agents' },
		{ href: '/history', label: 'History' }
	];

	const active = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(href + '/');

	onMount(() => {
		flushPending();
		addEventListener('online', flushPending);
		return () => removeEventListener('online', flushPending);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>2048 Lab</title>
</svelte:head>

<a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">Skip to content</a>

<header class="sticky top-0 z-30 border-b border-ink-200/60 bg-ink-50/80 backdrop-blur-xl dark:border-white/[0.06] dark:bg-ink-950/80">
	<div class="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
		<a href="/" class="flex shrink-0 items-center gap-2 font-bold tracking-tight">
			<img src={favicon} alt="" class="h-7 w-7" />
			<span>2048 <span class="text-accent-600 dark:text-accent-400">Lab</span></span>
		</a>
		<nav aria-label="Main" class="-mx-1 flex min-w-0 flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none]">
			{#each NAV as n (n.href)}
				<a
					href={n.href}
					aria-current={active(n.href) ? 'page' : undefined}
					class="rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap text-ink-600 transition-colors hover:bg-ink-900/5 hover:text-ink-900 aria-[current=page]:bg-ink-900/[0.07] aria-[current=page]:font-semibold aria-[current=page]:text-ink-900 dark:text-ink-300 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:bg-white/10 dark:aria-[current=page]:text-white"
					>{n.label}</a
				>
			{/each}
		</nav>
		<div class="flex shrink-0 items-center gap-2">
			{#if !online.value}
				<span class="rounded-full bg-accent-500/15 px-2 py-0.5 text-[11px] font-semibold text-accent-600 dark:text-accent-400" title="Local play keeps working; results sync when you're back online.">Offline</span>
			{/if}
			<button class="rounded-lg p-2 text-ink-600 hover:bg-ink-900/5 dark:text-ink-300 dark:hover:bg-white/5" onclick={() => theme.toggle()} aria-label={theme.dark ? 'Switch to light mode' : 'Switch to dark mode'}>
				{#if theme.dark}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
				{/if}
			</button>
		</div>
	</div>
</header>

<main id="main" class="mx-auto max-w-6xl px-4 pt-6 pb-20">
	{@render children()}
</main>
