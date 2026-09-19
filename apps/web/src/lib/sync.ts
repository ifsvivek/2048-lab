/**
 * Background upload of finished local games. One POST per finished game
 * (never per move), only for games worth keeping, retried when back online.
 */
import { SPEC_VERSION } from '@g2048/engine';
import { ApiError, ApiUnavailable, api } from './api';
import { MIN_UPLOAD_MOVES } from './config';
import { type LocalGame, allGames, saveGame } from './store';

export async function uploadGame(g: LocalGame): Promise<LocalGame> {
	if (!g.finishedAt) return g;
	if (g.moves.length < MIN_UPLOAD_MOVES) {
		const skipped = { ...g, sync: 'skipped' as const };
		await saveGame(skipped);
		return skipped;
	}
	try {
		const r = await api<{ replayCode: string; gameId: string }>('/v1/replays', {
			body: {
				specVersion: SPEC_VERSION,
				gameId: g.id,
				replayCode: g.replayCode,
				seed: g.seed,
				moves: g.moves,
				timing: g.timing.some((t) => t > 0) ? g.timing : undefined,
				playerKind: g.playerKind,
				agent: g.agent,
				runtime: { language: 'typescript', runtime: 'browser', platform: 'web' },
				startedAt: g.startedAt,
				finishedAt: g.finishedAt,
				final: { score: g.score, moveCount: g.moves.length }
			}
		});
		const synced = { ...g, replayCode: r.replayCode, sync: 'synced' as const };
		await saveGame(synced);
		return synced;
	} catch (e) {
		if (e instanceof ApiUnavailable) {
			const pending = { ...g, sync: 'pending' as const };
			await saveGame(pending);
			return pending;
		}
		if (e instanceof ApiError && (e.code === 'NOT_WORTH_STORING' || e.code === 'REPLAY_INVALID' || e.code === 'CONFLICT')) {
			const skipped = { ...g, sync: 'skipped' as const };
			await saveGame(skipped);
			return skipped;
		}
		throw e;
	}
}

let flushing = false;
export async function flushPending(): Promise<void> {
	if (flushing || !navigator.onLine) return;
	flushing = true;
	try {
		for (const g of await allGames()) {
			if (g.finishedAt && (g.sync === 'pending' || g.sync === 'local')) {
				try {
					await uploadGame(g);
				} catch {
					/* retry next time */
				}
			}
		}
	} finally {
		flushing = false;
	}
}
