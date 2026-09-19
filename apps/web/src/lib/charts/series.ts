/** Fixed entity → slot mapping. Never re-assigned by rank or filter. */
export const LANG_ORDER = ['typescript', 'rust', 'go', 'python'] as const;
export const LANG_COLOR: Record<string, string> = {
	typescript: 'var(--series-1)',
	rust: 'var(--series-2)',
	go: 'var(--series-3)',
	python: 'var(--series-4)'
};
export const langColor = (l: string) => LANG_COLOR[l] ?? 'var(--viz-muted)';

/** "Nice" axis maximum and ticks. */
export function niceTicks(max: number, count = 4): number[] {
	if (!(max > 0)) return [0, 1];
	const raw = max / count;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
	const ticks: number[] = [];
	for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(v);
	return ticks;
}
