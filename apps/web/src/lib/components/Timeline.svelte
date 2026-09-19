<!--
  Replay timeline: score curve over moves, milestone markers (first appearance
  of each new top tile ≥ 128) and a playhead. Pointer drag seeks; the range
  input underneath remains the keyboard/AT control.
-->
<script lang="ts">
	import { maxTile, type HistoryFrame } from '@g2048/engine';

	let { frames, idx, onseek }: { frames: HistoryFrame[]; idx: number; onseek: (i: number) => void } = $props();

	const W = 1000;
	const H = 90;
	const model = $derived.by(() => {
		const n = frames.length - 1 || 1;
		const top = frames[frames.length - 1]?.score || 1;
		const stepEvery = Math.max(1, Math.floor(frames.length / 500));
		let d = '';
		for (let i = 0; i < frames.length; i += stepEvery) d += `${i ? 'L' : 'M'}${((i / n) * W).toFixed(1)},${(H - (frames[i].score / top) * (H - 6)).toFixed(1)}`;
		d += `L${W},${(H - (frames[frames.length - 1].score / top) * (H - 6)).toFixed(1)}`;
		const marks: { i: number; x: number; y: number; t: number }[] = [];
		let best = 0;
		for (let i = 0; i < frames.length; i++) {
			const t = maxTile(frames[i].board);
			if (t > best) {
				if (t >= 128) marks.push({ i, x: (i / n) * W, y: H - (frames[i].score / top) * (H - 6), t });
				best = t;
			}
		}
		// Thin out labels that would collide (keep the later, larger milestone).
		const shown: typeof marks = [];
		for (const m of marks) {
			if (shown.length && m.x - shown[shown.length - 1].x < W * 0.045) shown[shown.length - 1] = m;
			else shown.push(m);
		}
		return { d, area: `${d}L${W},${H}L0,${H}Z`, marks: shown, n };
	});
	let hover = $state<number | null>(null);
	let dragging = false;

	function at(e: PointerEvent): number {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * model.n);
	}
</script>

<div class="relative">
	<svg
		viewBox="0 0 {W} {H}"
		preserveAspectRatio="none"
		class="h-20 w-full cursor-pointer touch-none select-none"
		role="img"
		aria-label="Score over the game with milestones; drag to seek"
		onpointerdown={(e) => {
			dragging = true;
			(e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
			onseek(at(e));
		}}
		onpointermove={(e) => {
			hover = at(e);
			if (dragging) onseek(hover);
		}}
		onpointerup={() => (dragging = false)}
		onpointerleave={() => (hover = null)}
	>
		<path d={model.area} fill="rgb(236 154 44 / 0.10)" />
		<path d={model.d} fill="none" stroke="var(--color-accent-500)" stroke-width="2" vector-effect="non-scaling-stroke" />
		<line x1={(idx / model.n) * W} x2={(idx / model.n) * W} y1="0" y2={H} stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" class="text-ink-900 dark:text-white" />
		{#if hover !== null}<line x1={(hover / model.n) * W} x2={(hover / model.n) * W} y1="0" y2={H} stroke="currentColor" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" class="text-ink-400" />{/if}
	</svg>
	<!-- Milestones as HTML so they don't stretch with the SVG -->
	{#each model.marks as m (m.i)}
		<button
			class="absolute -translate-x-1/2 -translate-y-1/2 rounded-md bg-(--surface) px-1 font-mono text-[10px] leading-4 font-medium shadow-[0_0_0_1px_var(--hairline)] transition-transform hover:scale-110 {idx >= m.i ? 'text-accent-600 dark:text-accent-400' : 'text-ink-400'}"
			style:left="{(m.x / W) * 100}%"
			style:top="{(m.y / H) * 80}px"
			onclick={() => onseek(m.i)}
			aria-label="Jump to move {m.i}, first {m.t} tile"
			title="move {m.i}: first {m.t}">{m.t >= 1024 ? `${m.t / 1024}k` : m.t}</button
		>
	{/each}
	{#if hover !== null}
		<div class="pointer-events-none absolute -top-6 -translate-x-1/2 rounded-md bg-ink-900 px-1.5 py-0.5 font-mono text-[10px] text-white dark:bg-ink-100 dark:text-ink-900" style:left="{(hover / model.n) * 100}%">
			#{hover} · {frames[hover]?.score.toLocaleString('en-US')}
		</div>
	{/if}
</div>
