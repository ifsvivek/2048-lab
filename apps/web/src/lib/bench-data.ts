/**
 * Benchmark data: the committed baseline (results/baseline/index.json, bundled
 * so dashboards render offline and instantly) merged with runs submitted to
 * the API. Everything is normalised to one flat `Run` shape.
 */
import baseline from '../../../../results/baseline/index.json';
import suite1 from '../../../../spec/benchmarks/engine-random-1k.json';
import suite2 from '../../../../spec/benchmarks/engine-random-10k.json';
import suite3 from '../../../../spec/benchmarks/expectimax-d2-10.json';
import suite4 from '../../../../spec/benchmarks/expectimax-d3-opening.json';
import suite5 from '../../../../spec/benchmarks/expectimax-canonical-3.json';
import expectedA from '../../../../spec/fixtures/benchmarks.json';
import expectedB from '../../../../spec/fixtures/benchmarks-heavy.json';
import type { BenchmarkSuite } from '@g2048/engine/sim';
import { api } from './api';

export const SUITES = [suite1, suite2, suite3, suite4, suite5] as unknown as BenchmarkSuite[];
export const EXPECTED: Record<string, { checksum: string }> = { ...expectedA.suites, ...expectedB.suites };

export interface Run {
	id: string;
	source: 'baseline' | 'runner' | 'browser' | 'server';
	suiteId: string;
	language: string;
	runtime: string;
	runtimeVersion: string;
	verified: boolean;
	checksum: string;
	games: number;
	avgScore: number | null;
	maxScore: number | null;
	maxTile: number | null;
	totalMoves: number | null;
	wallMs: number | null;
	gamesPerSec: number | null;
	movesPerSec: number | null;
	nodesPerSec: number | null;
	avgDecisionUs: number | null;
	p99DecisionUs: number | null;
	peakMemoryBytes: number | null;
	createdAt: number;
	cpu?: string;
	scores?: number[];
	tileDistribution?: Record<string, number>;
}

type BaselineRun = {
	suiteId: string;
	checksum: string;
	finishedAt: string;
	implementation: { language: string; runtime: string; runtimeVersion: string };
	environment: Record<string, string | number>;
	summary: Record<string, any>;
	scores?: number[];
};

export const BASELINE: Run[] = (baseline as unknown as { runs: BaselineRun[] }).runs.map((r, i) => ({
	id: `baseline-${i}`,
	source: 'baseline',
	suiteId: r.suiteId,
	language: r.implementation.language,
	runtime: r.implementation.runtime,
	runtimeVersion: r.implementation.runtimeVersion,
	verified: EXPECTED[r.suiteId]?.checksum === r.checksum,
	checksum: r.checksum,
	games: r.summary.games,
	avgScore: r.summary.avgScore,
	maxScore: r.summary.maxScore,
	maxTile: r.summary.maxTile,
	totalMoves: r.summary.totalMoves,
	wallMs: r.summary.wallMs,
	gamesPerSec: r.summary.gamesPerSec,
	movesPerSec: r.summary.movesPerSec,
	nodesPerSec: r.summary.nodesPerSec,
	avgDecisionUs: r.summary.avgDecisionUs,
	p99DecisionUs: r.summary.p99DecisionUs,
	peakMemoryBytes: r.summary.peakMemoryBytes,
	createdAt: Date.parse(r.finishedAt),
	cpu: String(r.environment.cpu ?? ''),
	scores: r.scores,
	tileDistribution: r.summary.tileDistribution
}));
export const BASELINE_CPU = BASELINE[0]?.cpu ?? '';

export async function remoteRuns(suite?: string): Promise<Run[]> {
	const q = suite ? `?suite=${encodeURIComponent(suite)}&limit=200` : '?limit=200';
	const { runs } = await api<{ runs: Run[] }>(`/v1/benchmarks/runs${q}`);
	return runs;
}
