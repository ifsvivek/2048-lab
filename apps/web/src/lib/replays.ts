/**
 * Replay resolution, local-first: this device's games → cached replays →
 * API (finished replays are immutable, so they are cached forever).
 */
import { classifyGameRef, SPEC_VERSION, type Replay } from '@g2048/engine';
import { ApiError, ApiUnavailable, api } from './api';
import { type CachedReplay, allGames, cacheReplay, gameByCode, getCachedReplay, getGame, type LocalGame } from './store';

export type ResolvedReplay = (Replay & { status?: string; source?: string }) & { origin: 'local' | 'cache' | 'api' };

function fromLocal(g: LocalGame): ResolvedReplay {
	return {
		origin: 'local',
		specVersion: SPEC_VERSION,
		gameId: g.id,
		replayCode: g.replayCode,
		status: g.finishedAt ? (g.over ? 'over' : 'abandoned') : 'in progress',
		seed: g.seed,
		moves: g.moves,
		final: { board: '', score: g.score, moveCount: g.moves.length, maxTile: g.maxTile, over: g.over, historyHash: '' },
		timing: g.timing,
		playerKind: g.playerKind,
		agent: g.agent,
		startedAt: g.startedAt,
		finishedAt: g.finishedAt ?? undefined
	};
}

import { count } from './telemetry';

export async function resolveReplay(ref: string): Promise<ResolvedReplay> {
	count('replay_views');
	const c = classifyGameRef(ref);
	if (!c) throw new ApiError('BAD_REF', 'Not a valid replay code or game ID.', 400);
	if (c.kind === 'id') {
		const g = await getGame(c.value);
		if (g) return fromLocal(g);
	} else {
		const g = await gameByCode(c.value);
		if (g) return fromLocal(g);
		const cached = await getCachedReplay(c.value);
		if (cached) return { ...cached, origin: 'cache' };
	}
	try {
		const r = await api<Replay & { status: string; replayCode: string }>(`/v1/replays/${encodeURIComponent(c.value)}`);
		if (r.status !== 'live') await cacheReplay({ ...r, cachedAt: Date.now() } as CachedReplay);
		return { ...r, origin: 'api' };
	} catch (e) {
		if (e instanceof ApiUnavailable) throw new ApiUnavailable("You're offline and this replay isn't cached on this device.");
		throw e;
	}
}

export async function localReplayList() {
	const games = (await allGames()).filter((g) => g.moves.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
	return games;
}
