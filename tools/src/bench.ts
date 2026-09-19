/**
 * Runs shared benchmark suites on every available runtime, writes results to
 * results/<suite>/<language>.json, prints a comparison and optionally submits
 * to the platform API.
 *
 *   pnpm bench [--suites a,b] [--lang rust,go] [--submit https://api…] [--out results/baseline]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resultsDir, specDir } from './paths.ts';
import { build, selected } from './runtimes.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const suites = (opt('suites') ?? 'engine-random-1k,engine-random-10k,expectimax-d2-10,expectimax-d3-opening').split(',');
const runtimes = selected(opt('lang'));
const outDir = resolve(opt('out') ?? join(resultsDir, 'local'));
const submit = opt('submit');
// Interpreters (CPython, Lua) take hours on the canonical suite; skip it unless explicitly requested.
const heavySkip = new Set(argv.includes('--all') ? [] : ['python:expectimax-canonical-3', 'lua:expectimax-canonical-3']);

/** The API stores ≤1000 per-game rows; checksum + summary already cover every game. */
const forUpload = (r: { games: unknown[] }) => (r.games.length > 1000 ? { ...r, games: r.games.slice(0, 1000) } : r);

type Row = { suite: string; language: string; checksum: string; s: any };
const rows: Row[] = [];
for (const r of runtimes) build(r);

for (const suite of suites) {
  const path = join(specDir, 'benchmarks', `${suite}.json`);
  mkdirSync(join(outDir, suite), { recursive: true });
  for (const r of runtimes) {
    if (heavySkip.has(`${r.language}:${suite}`)) {
      console.log(`[${r.language}] ${suite}: skipped (use --all)`);
      continue;
    }
    const file = join(outDir, suite, `${r.language}.json`);
    const t0 = Date.now();
    const res = spawnSync(r.cmd[0], [...r.cmd.slice(1), 'bench', '--suite', path, '--out', file], { cwd: r.cwd, stdio: ['ignore', 'ignore', 'inherit'] });
    if (res.status !== 0) {
      console.log(`[${r.language}] ${suite}: FAILED (exit ${res.status})`);
      continue;
    }
    const result = JSON.parse(readFileSync(file, 'utf8'));
    rows.push({ suite, language: r.language, checksum: result.checksum, s: result.summary });
    console.log(`[${r.language}] ${suite}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (submit) {
      const resp = await fetch(`${submit.replace(/\/$/, '')}/v1/benchmarks/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forUpload(result)) });
      const j = (await resp.json()) as { id?: string; verified?: boolean; message?: string };
      console.log(`    submitted → ${resp.status} ${j.id ?? j.message} verified=${j.verified}`);
    }
  }
}

const n = (x: number | null, d = 0) => (x === null || x === undefined ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: d }));
console.log('\nsuite                   language    checksum  moves/s       nodes/s        avg µs/decision  peak MB  avg score');
for (const r of rows) {
  console.log(
    `${r.suite.padEnd(23)} ${r.language.padEnd(11)} ${r.checksum}  ${n(r.s.movesPerSec).padStart(12)}  ${n(r.s.nodesPerSec).padStart(13)}  ${n(r.s.avgDecisionUs, 1).padStart(15)}  ${n((r.s.peakMemoryBytes ?? 0) / 2 ** 20, 0).padStart(7)}  ${n(r.s.avgScore).padStart(9)}`,
  );
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
