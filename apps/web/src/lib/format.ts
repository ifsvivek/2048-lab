export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '-' : Math.round(n).toLocaleString('en-US'));
export function fmtCompact(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return '-';
	return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: n >= 100 ? 0 : 1 }).format(n);
}
export function fmtUs(us: number | null | undefined): string {
	if (us === null || us === undefined || !Number.isFinite(us)) return '-';
	if (us < 1000) return `${us < 10 ? us.toFixed(1) : Math.round(us)} µs`;
	if (us < 1e6) return `${(us / 1000).toFixed(us < 1e4 ? 2 : 1)} ms`;
	return `${(us / 1e6).toFixed(2)} s`;
}
export function fmtBytes(b: number | null | undefined): string {
	if (b === null || b === undefined || !Number.isFinite(b)) return '-';
	const u = ['B', 'KB', 'MB', 'GB'];
	let i = 0;
	while (b >= 1024 && i < u.length - 1) {
		b /= 1024;
		i++;
	}
	return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
export function fmtAgo(ts: number | null | undefined): string {
	if (!ts) return '-';
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return new Date(ts).toLocaleDateString();
}
export const LANG_LABEL: Record<string, string> = { typescript: 'TypeScript', rust: 'Rust', go: 'Go', python: 'Python', c: 'C', cpp: 'C++', java: 'Java', csharp: 'C#', lua: 'Lua' };
