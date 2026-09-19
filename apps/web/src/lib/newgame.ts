import { generateReplayCode, randomSeed, ulid } from '@g2048/engine';
import { type LocalGame, saveGame } from './store';

/** Create a local game record: deterministic seed, game ID and replay code — no network needed. */
export async function createLocalGame(opts: { seed?: number; playerKind?: 'human' | 'agent'; agent?: LocalGame['agent'] } = {}): Promise<LocalGame> {
	const now = Date.now();
	const g: LocalGame = {
		id: ulid(now),
		replayCode: generateReplayCode(),
		seed: opts.seed ?? randomSeed(),
		moves: '',
		timing: [],
		playerKind: opts.playerKind ?? 'human',
		agent: opts.agent,
		startedAt: now,
		updatedAt: now,
		finishedAt: null,
		score: 0,
		maxTile: 0,
		over: false,
		sync: 'local'
	};
	await saveGame(g);
	return g;
}
