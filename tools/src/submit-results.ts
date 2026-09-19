/** Submit stored results (results/<set>/<suite>/<lang>.json) to an API. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resultsDir } from './paths.ts';

const [api, set = 'baseline', langs] = process.argv.slice(2);
if (!api) throw new Error('usage: submit-results.ts <apiUrl> [set] [lang,lang…]');
const only = langs ? new Set(langs.split(',')) : null;
const dir = join(resultsDir, set);
for (const suite of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
  for (const f of readdirSync(join(dir, suite)).filter((f) => f.endsWith('.json') && (!only || only.has(f.slice(0, -5))))) {
    const r = JSON.parse(readFileSync(join(dir, suite, f), 'utf8'));
    if (r.games.length > 1000) r.games = r.games.slice(0, 1000);
    const res = await fetch(`${api.replace(/\/$/, '')}/v1/benchmarks/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) });
    const j = (await res.json()) as { verified?: boolean; code?: string };
    console.log(`${suite}/${f} → ${res.status} verified=${j.verified ?? j.code}`);
  }
}
