<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { afterNavigate, onNavigate } from '$app/navigation';
	import { onMount } from 'svelte';
	import { flushPending } from '$lib/sync';
	import { online, theme } from '$lib/theme.svelte';
	import { count, startTelemetry } from '$lib/telemetry';
	import { API_URL, MCP_URL } from '$lib/config';
	import SunIcon from 'phosphor-svelte/lib/SunIcon';
	import MoonIcon from 'phosphor-svelte/lib/MoonIcon';

	let { children } = $props();

	const PLAY = [
		{ href: '/play', label: 'Play' },
		{ href: '/replay', label: 'Replays' },
		{ href: '/watch', label: 'Watch AI' }
	];
	const LAB = [
		{ href: '/runtimes', label: 'Runtimes' },
		{ href: '/benchmarks', label: 'Benchmarks' },
		{ href: '/analytics', label: 'Analytics' },
		{ href: '/agents', label: 'Agents' },
		{ href: '/leaderboard', label: 'Leaderboard' }
	];

	const active = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(href + '/');

	// Cross-fade route changes with the View Transitions API where supported.
	onNavigate((nav) => {
		if (!document.startViewTransition || nav.from?.url.pathname === nav.to?.url.pathname) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await nav.complete;
			});
		});
	});

	afterNavigate(() => count('page_views'));

	onMount(() => {
		startTelemetry();
		flushPending();
		addEventListener('online', flushPending);
		return () => removeEventListener('online', flushPending);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-(--surface) focus:px-3 focus:py-2 focus:shadow-lg">Skip to content</a>

<header class="sticky top-0 z-40 border-b border-(--hairline) bg-ink-50/75 backdrop-blur-xl backdrop-saturate-150 dark:bg-ink-950/70">
	<div class="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
		<a href="/" class="group flex shrink-0 items-center gap-2 font-semibold tracking-tight" aria-label="2048 Lab home">
			<img src={favicon} alt="" class="h-7 w-7 transition-transform duration-300 ease-(--ease-out-expo) group-hover:rotate-[-8deg]" />
			<span class="hidden sm:inline">2048 <span class="text-accent-600 dark:text-accent-400">Lab</span></span>
		</a>
		<nav aria-label="Main" class="-mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
			{#each PLAY as n (n.href)}
				{@render link(n)}
			{/each}
			<span class="mx-1.5 h-4 w-px shrink-0 bg-ink-900/10 dark:bg-white/10" aria-hidden="true"></span>
			{#each LAB as n (n.href)}
				{@render link(n)}
			{/each}
		</nav>
		<div class="flex shrink-0 items-center gap-1.5">
			{#if !online.value}
				<span class="flex items-center gap-1.5 rounded-md bg-accent-400/15 px-2 py-1 text-[11px] font-medium text-accent-600 dark:text-accent-300" title="Local play keeps working; results sync when you're back online.">
					<span class="h-1.5 w-1.5 rounded-full bg-accent-500"></span>Offline
				</span>
			{/if}
			<button class="grid h-9 w-9 place-items-center rounded-xl text-ink-600 transition-colors hover:bg-ink-900/5 dark:text-ink-300 dark:hover:bg-white/5" onclick={() => theme.toggle()} aria-label={theme.dark ? 'Switch to light theme' : 'Switch to dark theme'}>
				{#if theme.dark}<SunIcon size={18} />{:else}<MoonIcon size={18} />{/if}
			</button>
		</div>
	</div>
</header>

{#snippet link(n: { href: string; label: string })}
	<a
		href={n.href}
		aria-current={active(n.href) ? 'page' : undefined}
		class="relative shrink-0 rounded-lg px-2.5 py-1.5 text-[13.5px] whitespace-nowrap text-ink-500 transition-colors duration-200 hover:text-ink-900 aria-[current=page]:font-medium aria-[current=page]:text-ink-950 dark:text-ink-400 dark:hover:text-white dark:aria-[current=page]:text-white"
	>
		{n.label}
		{#if active(n.href)}<span class="absolute inset-x-2.5 -bottom-[9px] h-[2px] rounded-full bg-accent-500" style="view-transition-name: nav-indicator"></span>{/if}
	</a>
{/snippet}

<main id="main" class="mx-auto min-h-[calc(100dvh-3.5rem)] max-w-6xl px-4 pt-8 pb-24 sm:px-6">
	{@render children()}
</main>

<footer class="border-t border-(--hairline)">
	<div class="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-[1.4fr_1fr_1fr] sm:px-6">
		<div>
			<div class="flex items-center gap-2 font-semibold"><img src={favicon} alt="" class="h-6 w-6" /> 2048 Lab</div>
			<p class="mt-2 max-w-xs text-ink-500 dark:text-ink-400">A deterministic 2048 lab. Every game is a seed plus a list of moves, and it replays identically in nine languages.</p>
		</div>
		<div>
			<div class="label mb-2">Build on it</div>
			<ul class="space-y-1.5">
				<li><a class="btn-link" href="{API_URL}/v1/health">REST API</a></li>
				<li><a class="btn-link" href="/agents">Connect an agent</a></li>
				<li><span class="text-ink-500 dark:text-ink-400">MCP · </span><code class="mono text-xs">{MCP_URL.replace(/^https?:\/\//, '')}</code></li>
			</ul>
		</div>
		<div>
			<div class="label mb-2">Privacy</div>
			<p class="text-ink-500 dark:text-ink-400">No accounts, no cookies, no IPs stored. Players are anonymous browser IDs, and analytics are aggregated.</p>
		</div>
	</div>
</footer>
