/** Human units for tiny-to-large physical quantities (estimates). */
export function fmtEnergy(kwh: number | null | undefined): string {
	if (kwh === null || kwh === undefined || !Number.isFinite(kwh)) return '—';
	const wh = kwh * 1000;
	if (wh === 0) return '0 Wh';
	if (wh < 0.001) return `${(wh * 1e6).toFixed(wh * 1e6 < 10 ? 1 : 0)} µWh`;
	if (wh < 1) return `${(wh * 1000).toFixed(wh * 1000 < 10 ? 1 : 0)} mWh`;
	if (wh < 1000) return `${wh.toFixed(wh < 10 ? 2 : 1)} Wh`;
	return `${kwh.toFixed(kwh < 10 ? 2 : 1)} kWh`;
}
export function fmtWater(l: number | null | undefined): string {
	if (l === null || l === undefined || !Number.isFinite(l)) return '—';
	if (l < 1) return `${(l * 1000).toFixed(l * 1000 < 10 ? 1 : 0)} mL`;
	return `${l.toFixed(l < 10 ? 2 : 1)} L`;
}
export function fmtCarbon(kg: number | null | undefined): string {
	if (kg === null || kg === undefined || !Number.isFinite(kg)) return '—';
	if (kg === 0) return '0 g CO₂e';
	if (kg < 1e-6) return `${(kg * 1e9).toFixed(1)} µg CO₂e`;
	if (kg < 1e-3) return `${(kg * 1e6).toFixed(kg * 1e6 < 10 ? 1 : 0)} mg CO₂e`;
	if (kg < 1) return `${(kg * 1000).toFixed(kg * 1000 < 10 ? 2 : 1)} g CO₂e`;
	return `${kg.toFixed(2)} kg CO₂e`;
}
export function fmtUsd(v: number | null | undefined): string {
	if (v === null || v === undefined || !Number.isFinite(v)) return '—';
	if (v === 0) return '$0';
	// Two significant figures as a plain decimal: $0.0000052 reads better than $5.2e-6.
	if (v < 0.01) return `$${v.toFixed(Math.min(12, 1 - Math.floor(Math.log10(v))))}`;
	if (v < 1) return `$${v.toFixed(4)}`;
	return `$${v.toFixed(2)}`;
}
export function fmtDuration(s: number | null | undefined): string {
	if (s === null || s === undefined || !Number.isFinite(s)) return '—';
	if (s < 1) return `${Math.round(s * 1000)} ms`;
	if (s < 120) return `${s.toFixed(1)} s`;
	if (s < 7200) return `${(s / 60).toFixed(1)} min`;
	return `${(s / 3600).toFixed(1)} h`;
}
