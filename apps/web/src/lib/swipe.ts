import type { Direction } from '@g2048/engine';

/** Svelte action: pointer swipes → direction callback (up/down/left/right = 0/1/2/3). */
export function swipe(node: HTMLElement, onSwipe: (d: Direction) => void) {
	let x0 = 0;
	let y0 = 0;
	let active = false;
	const down = (e: PointerEvent) => {
		active = true;
		x0 = e.clientX;
		y0 = e.clientY;
	};
	const up = (e: PointerEvent) => {
		if (!active) return;
		active = false;
		const dx = e.clientX - x0;
		const dy = e.clientY - y0;
		if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
		onSwipe(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 2) : dy > 0 ? 1 : 0);
	};
	node.style.touchAction = 'none';
	node.addEventListener('pointerdown', down);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', () => (active = false));
	return {
		update(fn: (d: Direction) => void) {
			onSwipe = fn;
		},
		destroy() {
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointerup', up);
		}
	};
}

export const KEY_DIR: Record<string, Direction> = {
	ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3,
	w: 0, s: 1, a: 2, d: 3, W: 0, S: 1, A: 2, D: 3,
	k: 0, j: 1, h: 2, l: 3
};
