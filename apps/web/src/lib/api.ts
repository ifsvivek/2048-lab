/**
 * Thin, typed client for the platform API. Every call is optional for the
 * app to function: callers must handle ApiUnavailable and fall back to local
 * data (offline-first).
 */
import { API_URL } from './config';

export class ApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: Record<string, unknown>;
	constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
		super(message);
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export class ApiUnavailable extends Error {}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiUnavailable('offline');
	let res: Response;
	try {
		res = await fetch(API_URL + path, {
			method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
			headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			signal: AbortSignal.timeout(init.timeoutMs ?? 10_000)
		});
	} catch (e) {
		throw new ApiUnavailable((e as Error).message);
	}
	const json = await res.json().catch(() => null);
	if (!res.ok) throw new ApiError(json?.code ?? 'HTTP_' + res.status, json?.message ?? res.statusText, res.status, json?.details);
	return json as T;
}

export function wsUrl(path: string): string {
	return API_URL.replace(/^http/, 'ws') + path;
}
