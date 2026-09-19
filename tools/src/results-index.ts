/**
 * Compacts results/<set>/<suite>/<language>.json into results/<set>/index.json
 * (summaries only) for the web dashboard, and records the reference checksums
 * of heavy suites in spec/fixtures/benchmarks-heavy.json (verified by the API,
 * not run by per-language test suites).
 *
 *   node tools/src/results-index.ts [set=baseline]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resultsDir, specDir } from './paths.ts';

const set = process.argv[2] ?? 'baseline';
const dir = join(resultsDir, set);
const runs: unknown[] = [];
const heavy: Record<string, unknown> = {};
for (const suite of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()).sort()) {
  for (const f of readdirSync(join(dir, suite)).filter((f) => f.endsWith('.json')).sort()) {
    const r = JSON.parse(readFileSync(join(dir, suite, f), 'utf8'));
    const { games, ...rest } = r;
    runs.push({ ...rest, scores: games.length <= 50 ? games.map((g: { score: number }) => g.score) : undefined });
    if (r.implementation.language === 'typescript' && (suite === 'engine-random-10k' || suite === 'expectimax-canonical-3')) {
      heavy[suite] = {
        checksum: r.checksum,
        games: r.summary.games,
        totalMoves: r.summary.totalMoves,
        totalScore: games.reduce((a: number, g: { score: number }) => a + g.score, 0),
        maxScore: r.summary.maxScore,
      };
    }
  }
}
writeFileSync(join(dir, 'index.json'), JSON.stringify({ set, generatedAt: new Date().toISOString(), runs }, null, 1) + '\n');
if (Object.keys(heavy).length) {
  writeFileSync(
    join(specDir, 'fixtures', 'benchmarks-heavy.json'),
    JSON.stringify({ specVersion: 1, generatedBy: 'typescript-reference', description: 'Expected outcomes of heavy suites (too slow for per-port unit tests); used by the API to mark submitted runs as verified.', suites: heavy }, null, 1) + '\n',
  );
}
console.log(`indexed ${runs.length} runs → results/${set}/index.json`);
