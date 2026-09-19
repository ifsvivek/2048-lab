/// <reference lib="webworker" />
/**
 * AI + benchmark worker. Keeps expectimax (and its 16 MB transposition table)
 * off the UI thread.
 *
 *   → { id, type: 'decide', boardHex, seed, score, moveCount, agent, config }
 *   ← { id, type: 'decision', move, metrics }
 *   → { id, type: 'bench', suite }
 *   ← { id, type: 'progress', done, total, game } … { id, type: 'result', result }
 */
import { SPEC_VERSION, boardFromHex } from '@g2048/engine';
import { type Agent, type BuiltinAgentId, createBuiltinAgent } from '@g2048/engine/ai';
import { type BenchmarkSuite, runSuite } from '@g2048/engine/sim';

let agent: Agent | null = null;
let agentKey = '';

self.onmessage = async (e: MessageEvent) => {
	const m = e.data;
	try {
		if (m.type === 'decide') {
			const key = JSON.stringify([m.agent, m.config, m.seed]);
			if (!agent || key !== agentKey) {
				agent = createBuiltinAgent(m.agent as BuiltinAgentId, m.config ?? {});
				agent.reset?.({ seed: m.seed, specVersion: SPEC_VERSION });
				agentKey = key;
			}
			const d = await agent.decide({ board: boardFromHex(m.boardHex), score: m.score, moveCount: m.moveCount, meta: { seed: m.seed, specVersion: SPEC_VERSION } });
			postMessage({ id: m.id, type: 'decision', move: d.move, metrics: d.metrics });
		} else if (m.type === 'bench') {
			const suite = m.suite as BenchmarkSuite;
			const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number };
			const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
			const result = await runSuite(suite, {
				implementation: { language: 'typescript', runtime: 'browser', runtimeVersion: navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? 'unknown', engineVersion: '1.0.0', platform: 'browser' },
				environment: { userAgent: navigator.userAgent, cores: nav.hardwareConcurrency ?? 0, deviceMemoryGB: nav.deviceMemory ?? 0, ttPolicy: 'reference' },
				memory: () => perf.memory?.usedJSHeapSize ?? null,
				onGame: (game, i) => postMessage({ id: m.id, type: 'progress', done: i + 1, total: suite.seeds.count, game }),
				yieldBetweenGames: () => new Promise((r) => setTimeout(r, 0))
			});
			postMessage({ id: m.id, type: 'result', result });
		}
	} catch (err) {
		postMessage({ id: m.id, type: 'error', message: (err as Error).message });
	}
};
