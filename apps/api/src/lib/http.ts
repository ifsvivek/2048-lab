import type { Context } from 'hono';
import type { Env } from '../env.ts';
import { ApiError, decodeRpcError } from './errors.ts';

export type AppEnv = { Bindings: Env; Variables: { requestId: string } };
export type Ctx = Context<AppEnv>;

/** Await a Durable Object RPC call, translating encoded ApiErrors back. */
export async function rpc<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw decodeRpcError(e) ?? e;
  }
}

export async function body<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  if (text.length > 1_000_000) throw new ApiError('BAD_REQUEST', 'request body too large (max 1 MB)');
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw new ApiError('BAD_REQUEST', 'request body must be a JSON object');
  }
}

export function optInt(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ApiError('BAD_REQUEST', `${name} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

export function optStr(v: unknown, name: string, maxLen = 200): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > maxLen) throw new ApiError('BAD_REQUEST', `${name} must be a string of at most ${maxLen} chars`);
  return v;
}

export function optObj(v: unknown, name: string): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ApiError('BAD_REQUEST', `${name} must be an object`);
  if (JSON.stringify(v).length > 4000) throw new ApiError('BAD_REQUEST', `${name} is too large`);
  return v as Record<string, unknown>;
}

export async function rateLimit(c: Ctx, which: 'CREATE_LIMITER' | 'WRITE_LIMITER'): Promise<void> {
  const limiter = c.env[which];
  if (!limiter) return;
  const key = c.req.header('cf-connecting-ip') ?? 'anon';
  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError('RATE_LIMITED', 'Too many requests; slow down and retry shortly.');
}

export function bearer(c: Ctx): string | null {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/**
 * Edge-cache a JSON GET response in the colo cache. Leaderboards, stats and
 * finished replays are read far more often than they change, so this keeps
 * D1 reads (5M rows/day on the free tier) low.
 */
export async function edgeCached(c: Ctx, ttlSeconds: number, produce: () => Promise<unknown>): Promise<Response> {
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const key = new Request(c.req.url, { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const r = new Response(hit.body, hit);
      r.headers.set('x-cache', 'HIT');
      return r;
    }
  }
  const data = await produce();
  const res = new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': ttlSeconds >= 86400 ? `public, max-age=${ttlSeconds}, immutable` : `public, max-age=${ttlSeconds}`,
      'x-cache': 'MISS',
    },
  });
  if (cache) c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}
