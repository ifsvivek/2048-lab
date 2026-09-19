/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * Offline-first service worker:
 *  - precaches the app shell and every built asset (the whole game works offline);
 *  - finished replays (GET /v1/replays/<code>) are immutable → cache-first;
 *  - other API GETs → network-first with cached fallback;
 *  - writes are never cached (the app queues uploads itself).
 */
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const SHELL = `shell-${version}`;
const RUNTIME = 'api-v1';
const PRECACHE = [...build, ...files, '/'];

sw.addEventListener('install', (e) => {
	e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
	e.waitUntil(
		caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);

	if (url.origin === location.origin) {
		// App shell: assets from cache; navigations fall back to the SPA shell offline.
		e.respondWith(
			(async () => {
				const cache = await caches.open(SHELL);
				const hit = await cache.match(url.pathname);
				if (hit) return hit;
				try {
					return await fetch(req);
				} catch {
					return (req.mode === 'navigate' ? await cache.match('/') : undefined) ?? Response.error();
				}
			})()
		);
		return;
	}

	if (!url.pathname.startsWith('/v1/') || url.pathname.endsWith('/live')) return;
	const immutable = /^\/v1\/replays\/[A-Z0-9-]+$/i.test(url.pathname);
	e.respondWith(
		(async () => {
			const cache = await caches.open(RUNTIME);
			if (immutable) {
				const hit = await cache.match(req);
				if (hit) return hit;
			}
			try {
				const res = await fetch(req);
				// Only cache finished replays (live ones say no-store) and successful reads.
				if (res.ok && !(res.headers.get('cache-control') ?? '').includes('no-store')) cache.put(req, res.clone());
				return res;
			} catch {
				return (await cache.match(req)) ?? Response.error();
			}
		})()
	);
});
