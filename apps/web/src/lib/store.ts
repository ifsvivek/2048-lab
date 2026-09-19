/**
 * IndexedDB persistence for offline-first play:
 *   games   — every locally played game (the source of truth for local play)
 *   replays — cached remote replays (immutable once finished)
 *   meta    — small key/value settings
 */
import type { Replay } from '@g2048/engine';

export interface LocalGame {
	id: string;
	replayCode: string;
	seed: number;
	moves: string;
	timing: number[];
	playerKind: 'human' | 'agent';
	agent?: { name: string; version?: string; config?: Record<string, unknown> };
	startedAt: number;
	updatedAt: number;
	finishedAt: number | null;
	score: number;
	maxTile: number;
	over: boolean;
	/** 'local' → not uploaded; 'synced' → stored server-side (replayCode may have been reassigned) */
	sync: 'local' | 'pending' | 'synced' | 'skipped';
	/** search statistics when an AI played (for agent analytics) */
	aiStats?: { depthSum: number; depthSamples: number };
}

const DB_NAME = 'g2048';
const VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
	dbp ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, VERSION);
		req.onupgradeneeded = () => {
			const d = req.result;
			const games = d.createObjectStore('games', { keyPath: 'id' });
			games.createIndex('replayCode', 'replayCode', { unique: false });
			games.createIndex('updatedAt', 'updatedAt');
			d.createObjectStore('replays', { keyPath: 'replayCode' });
			d.createObjectStore('meta');
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return db().then(
		(d) =>
			new Promise<T>((resolve, reject) => {
				const r = fn(d.transaction(store, mode).objectStore(store));
				r.onsuccess = () => resolve(r.result);
				r.onerror = () => reject(r.error);
			})
	);
}

export const saveGame = (g: LocalGame) => tx('games', 'readwrite', (s) => s.put({ ...g, updatedAt: Date.now() }));
export const getGame = (id: string) => tx<LocalGame | undefined>('games', 'readonly', (s) => s.get(id));
export const deleteGame = (id: string) => tx('games', 'readwrite', (s) => s.delete(id));
export const allGames = () => tx<LocalGame[]>('games', 'readonly', (s) => s.getAll());
export const gameByCode = (code: string) => tx<LocalGame | undefined>('games', 'readonly', (s) => s.index('replayCode').get(code));

export type CachedReplay = Replay & { replayCode: string; status?: string; cachedAt: number };
export const cacheReplay = (r: CachedReplay) => tx('replays', 'readwrite', (s) => s.put(r));
export const getCachedReplay = (code: string) => tx<CachedReplay | undefined>('replays', 'readonly', (s) => s.get(code));
export const allCachedReplays = () => tx<CachedReplay[]>('replays', 'readonly', (s) => s.getAll());

export const getMeta = <T>(key: string) => tx<T | undefined>('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key: string, value: unknown) => tx('meta', 'readwrite', (s) => s.put(value, key));
