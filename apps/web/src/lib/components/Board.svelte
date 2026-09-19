<script lang="ts" module>
	export interface BoardStep {
		prev: Uint8Array;
		dir: 0 | 1 | 2 | 3;
		spawn: { index: number; exponent: number } | null;
	}

	/** [background, foreground] per exponent. */
	const PALETTE: [string, string][] = [
		['transparent', 'inherit'],
		['#eee4da', '#3d3a33'], // 2
		['#ede0c8', '#3d3a33'], // 4
		['#f3b079', '#fffaf2'], // 8
		['#f59563', '#fffaf2'], // 16
		['#f67c5f', '#fffaf2'], // 32
		['#f65e3b', '#fffaf2'], // 64
		['#edcf72', '#fffaf2'], // 128
		['#edcc61', '#fffaf2'], // 256
		['#edc850', '#fffaf2'], // 512
		['#edc53f', '#fffaf2'], // 1024
		['#edc22e', '#fffaf2'], // 2048
		['#9b6bde', '#fffaf2'], // 4096
		['#7c4fd1', '#fffaf2'], // 8192
		['#5b3bb8', '#fffaf2'], // 16384
		['#3e2c8f', '#fffaf2'], // 32768
		['#26206a', '#fffaf2'], // 65536
		['#120f3d', '#fffaf2'] // 131072
	];

	export function tileColors(e: number): [string, string] {
		return PALETTE[Math.min(e, PALETTE.length - 1)];
	}
</script>

<script lang="ts">
	import { moveMotions } from '@g2048/engine';
	import { untrack } from 'svelte';

	interface Props {
		board: Uint8Array;
		/** the move that produced `board`, used to animate slides/merges/spawns */
		step?: BoardStep | null;
		animate?: boolean;
		label?: string;
		/** highlight the cell of the last spawn */
		dim?: boolean;
	}

	let { board, step = null, animate = true, label = 'Game board', dim = false }: Props = $props();

	type Tile = { id: number; e: number; pos: number; kind: 'idle' | 'new' | 'merged'; dying: boolean };

	let tiles = $state<Tile[]>([]);
	let nextId = 1;
	let shown = '';
	let cleanup: ReturnType<typeof setTimeout> | undefined;

	const key = (b: Uint8Array) => Array.from(b).join(',');

	function rebuild(b: Uint8Array) {
		const t: Tile[] = [];
		for (let i = 0; i < 16; i++) if (b[i]) t.push({ id: nextId++, e: b[i], pos: i, kind: 'idle', dying: false });
		tiles = t;
	}

	function moveMs(): number {
		const v = getComputedStyle(document.documentElement).getPropertyValue('--tile-move-ms');
		return parseFloat(v) || 0;
	}

	function applyStep(s: BoardStep, b: Uint8Array): boolean {
		const current = tiles.filter((t) => !t.dying);
		const byPos = new Map(current.map((t) => [t.pos, t]));
		const next: Tile[] = [];
		const mergedAt = new Set<number>();
		for (const m of moveMotions(s.prev, s.dir)) {
			const t = byPos.get(m.from);
			if (!t) return false;
			if (m.merged) {
				next.push({ ...t, pos: m.to, dying: true, kind: 'idle' });
				mergedAt.add(m.to);
			} else next.push({ ...t, pos: m.to, kind: 'idle' });
		}
		for (const pos of mergedAt) next.push({ id: nextId++, e: b[pos], pos, kind: 'merged', dying: false });
		if (s.spawn) next.push({ id: nextId++, e: s.spawn.exponent, pos: s.spawn.index, kind: 'new', dying: false });
		tiles = next;
		clearTimeout(cleanup);
		cleanup = setTimeout(() => (tiles = tiles.filter((t) => !t.dying)), moveMs() + 30);
		return true;
	}

	$effect(() => {
		const k = key(board);
		const s = step;
		const a = animate;
		untrack(() => {
			if (k === shown) return;
			const ok = a && s && key(s.prev) === shown && applyStep(s, board);
			if (!ok) rebuild(board);
			shown = k;
		});
	});

	const label2 = (e: number) => (e ? String(2 ** e) : '');
	function fontSize(e: number): string {
		const d = label2(e).length;
		return d <= 2 ? '11cqw' : d === 3 ? '9.2cqw' : d === 4 ? '7.4cqw' : d === 5 ? '6cqw' : '5cqw';
	}
</script>

<div class="board relative aspect-square w-full select-none" class:opacity-60={dim} style="container-type: inline-size;">
	<!-- Accessible representation -->
	<table class="sr-only" aria-label={label}>
		<tbody>
			{#each [0, 1, 2, 3] as r (r)}
				<tr>
					{#each [0, 1, 2, 3] as c (c)}
						<td>{board[r * 4 + c] ? 2 ** board[r * 4 + c] : 'empty'}</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>

	<div class="absolute inset-0 rounded-[3.2cqw] bg-ink-200 p-[var(--gap)] dark:bg-ink-800" aria-hidden="true">
		<div class="grid h-full w-full grid-cols-4 grid-rows-4 gap-[var(--gap)]">
			{#each Array(16) as _, i (i)}
				<div class="rounded-[2cqw] bg-ink-100/80 dark:bg-ink-900/60"></div>
			{/each}
		</div>
	</div>

	<div class="absolute inset-[var(--gap)]" aria-hidden="true">
		{#each tiles as t (t.id)}
			{@const [bg, fg] = tileColors(t.e)}
			<div
				class="tile absolute top-0 left-0 flex items-center justify-center rounded-[2cqw] font-bold"
				class:tile-new={t.kind === 'new'}
				class:tile-merged={t.kind === 'merged'}
				style:width="calc((100% - 3 * var(--gap)) / 4)"
				style:height="calc((100% - 3 * var(--gap)) / 4)"
				style:transform="translate(calc({t.pos % 4} * (100% + var(--gap))), calc({Math.floor(t.pos / 4)} * (100% + var(--gap))))"
				style:z-index={t.dying ? 1 : 2}
				style:background={bg}
				style:color={fg}
				style:font-size={fontSize(t.e)}
				style:box-shadow={t.e >= 11 ? `0 0 3cqw ${bg}66` : 'none'}
			>
				{label2(t.e)}
			</div>
		{/each}
	</div>
</div>

<style>
	.board {
		--gap: 2.6cqw;
	}
	.tile {
		transition: transform var(--tile-move-ms) var(--ease-snap);
		letter-spacing: -0.03em;
		will-change: transform;
	}
	.tile-new {
		animation: appear 160ms var(--tile-move-ms) both var(--ease-snap);
	}
	.tile-merged {
		animation: pop 180ms var(--tile-move-ms) both var(--ease-snap);
	}
	@keyframes appear {
		from {
			opacity: 0;
			scale: 0.3;
		}
		to {
			opacity: 1;
			scale: 1;
		}
	}
	@keyframes pop {
		0% {
			scale: 0.6;
			opacity: 0;
		}
		60% {
			scale: 1.12;
			opacity: 1;
		}
		100% {
			scale: 1;
		}
	}
</style>
