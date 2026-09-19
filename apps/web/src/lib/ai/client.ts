import type { Direction } from '@g2048/engine';
import type { DecisionMetrics } from '@g2048/engine/ai';
import type { BenchmarkResult, BenchmarkSuite, GameResult } from '@g2048/engine/sim';

/** Promise wrapper around a dedicated AI worker. */
export class AiWorker {
	private worker: Worker;
	private seq = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (p: any) => void }>();

	constructor() {
		this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
		this.worker.onmessage = (e) => {
			const m = e.data;
			const p = this.pending.get(m.id);
			if (!p) return;
			if (m.type === 'progress') return p.onProgress?.(m);
			this.pending.delete(m.id);
			if (m.type === 'error') p.reject(new Error(m.message));
			else p.resolve(m);
		};
	}

	private send<T>(msg: Record<string, unknown>, onProgress?: (p: any) => void): Promise<T> {
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onProgress });
			this.worker.postMessage({ ...msg, id });
		});
	}

	decide(args: { boardHex: string; seed: number; score: number; moveCount: number; agent: string; config?: Record<string, unknown> }) {
		return this.send<{ move: Direction; metrics: DecisionMetrics }>({ type: 'decide', ...args });
	}

	bench(suite: BenchmarkSuite, onProgress: (p: { done: number; total: number; game: GameResult }) => void) {
		return this.send<{ result: BenchmarkResult }>({ type: 'bench', suite }, onProgress).then((m) => m.result);
	}

	terminate() {
		this.worker.terminate();
		for (const p of this.pending.values()) p.reject(new Error('terminated'));
		this.pending.clear();
	}
}
