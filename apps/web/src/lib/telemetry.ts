/**
 * Privacy-preserving analytics client.
 *  - playerId: random token in localStorage (anonymous; clearing storage resets it)
 *  - sessionId: random token per browser tab session
 *  - counters are accumulated in memory and sent in ONE beacon when the page is
 *    hidden; the first beacon of a session also lets the server record the
 *    aggregated device/browser/os/country (derived server-side, never stored per user).
 */
import { API_URL } from './config';

type Counter = 'replay_views' | 'games_started' | 'page_views' | 'ai_games_started' | 'benchmarks_run_browser';

function token(): string {
	const b = new Uint8Array(16);
	crypto.getRandomValues(b);
	return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stored(storage: Storage, key: string): string {
	let v = storage.getItem(key);
	if (!v) {
		v = token();
		storage.setItem(key, v);
	}
	return v;
}

export const playerId = () => stored(localStorage, 'g2048.player');
export const sessionId = () => stored(sessionStorage, 'g2048.session');

const counters: Partial<Record<Counter, number>> = {};

export function count(name: Counter, n = 1): void {
	counters[name] = (counters[name] ?? 0) + n;
}

function flush(): void {
	const pending = Object.entries(counters).filter(([, v]) => v);
	const first = sessionStorage.getItem('g2048.beaconed') !== '1';
	if (!pending.length && !first) return;
	// text/plain keeps sendBeacon a CORS "simple request" (no preflight).
	const ok = navigator.sendBeacon?.(`${API_URL}/v1/analytics/events`, JSON.stringify({ sessionId: sessionId(), first, counters: Object.fromEntries(pending) }));
	if (ok) {
		for (const k of Object.keys(counters)) delete counters[k as Counter];
		sessionStorage.setItem('g2048.beaconed', '1');
	}
}

let started = false;
export function startTelemetry(): void {
	if (started || typeof window === 'undefined') return;
	started = true;
	addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
	addEventListener('pagehide', flush);
}
