/**
 * Motion primitives. All respect prefers-reduced-motion (CSS in app.css
 * neutralises the transitions; count-up jumps straight to the final value).
 */
import type { Action } from 'svelte/action';

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let io: IntersectionObserver | null = null;
function observer(): IntersectionObserver {
	io ??= new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				e.target.classList.add('is-in');
				io!.unobserve(e.target);
			}
		},
		{ rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
	);
	return io;
}

/** Fade/lift into view once. `use:reveal={i}` staggers by i × 55 ms. */
export const reveal: Action<HTMLElement, number | undefined> = (node, i = 0) => {
	node.classList.add('reveal');
	node.style.setProperty('--i', String(i));
	observer().observe(node);
	return { destroy: () => io?.unobserve(node) };
};

/** Invoke `cb` once when the node first becomes visible (e.g. start a chart animation). */
export const onVisible: Action<HTMLElement, () => void> = (node, cb) => {
	const o = new IntersectionObserver(
		([e]) => {
			if (e.isIntersecting) {
				cb();
				o.disconnect();
			}
		},
		{ threshold: 0.25 }
	);
	o.observe(node);
	return { destroy: () => o.disconnect() };
};

/** Tween a number toward `target` (ease-out-expo, 900 ms). Returns a stop function. */
export function tween(from: number, to: number, set: (v: number) => void, ms = 900): () => void {
	if (reducedMotion() || from === to) {
		set(to);
		return () => {};
	}
	const t0 = performance.now();
	let raf = 0;
	const step = (t: number) => {
		const k = Math.min(1, (t - t0) / ms);
		const e = 1 - Math.pow(2, -10 * k);
		set(from + (to - from) * (k === 1 ? 1 : e));
		if (k < 1) raf = requestAnimationFrame(step);
	};
	raf = requestAnimationFrame(step);
	return () => cancelAnimationFrame(raf);
}
