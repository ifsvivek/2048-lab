/**
 * Cross-language validation: builds every available implementation, runs its
 * fixture checks, then cross-checks that all of them produce identical
 * benchmark checksums. Exit code 1 on any disagreement.
 *
 *   pnpm validate [--lang typescript,go]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { specDir } from './paths.ts';
import { RUNTIMES, build, selected } from './runtimes.ts';

const argv = process.argv.slice(2);
const langArg = argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : undefined;
const runtimes = selected(langArg);
const missing = RUNTIMES.filter((r) => !runtimes.includes(r) && (!langArg || langArg.includes(r.language)));
let failed = false;

console.log('== fixture validation ==');
for (const r of runtimes) {
  build(r);
  const res = spawnSync(r.cmd[0], [...r.cmd.slice(1), 'validate', '--json'], { cwd: r.cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  // Output may be pretty-printed; take the last top-level JSON object.
  const out = res.stdout.trim();
  const line = out.slice(out.lastIndexOf('\n{') + 1);
  let rep: { passed: number; failed: number; failures?: { fixture: string; case: string; message: string }[] };
  try {
    rep = JSON.parse(line);
  } catch {
    console.log(`  ${r.language.padEnd(11)} ERROR: ${res.stderr.slice(0, 500)}`);
    failed = true;
    continue;
  }
  console.log(`  ${r.language.padEnd(11)} ${rep.failed ? 'FAIL' : 'ok  '} ${rep.passed} passed, ${rep.failed} failed`);
  for (const f of rep.failures?.slice(0, 10) ?? []) console.log(`      ${f.fixture} ${f.case}: ${f.message}`);
  if (rep.failed) failed = true;
}
for (const r of missing) console.log(`  ${r.language.padEnd(11)} skipped (toolchain not installed)`);

console.log('\n== cross-runtime determinism (engine-random-1k, expectimax-d2-10) ==');
const expected = JSON.parse(readFileSync(join(specDir, 'fixtures/benchmarks.json'), 'utf8')).suites;
for (const suite of ['engine-random-1k', 'expectimax-d2-10']) {
  const seen: Record<string, string> = {};
  for (const r of runtimes) {
    const out = execFileSync(r.cmd[0], [...r.cmd.slice(1), 'bench', '--suite', join(specDir, 'benchmarks', `${suite}.json`)], {
      cwd: r.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 << 20,
    });
    seen[r.language] = JSON.parse(out).checksum;
  }
  const ok = Object.values(seen).every((c) => c === expected[suite].checksum);
  if (!ok) failed = true;
  console.log(`  ${suite.padEnd(22)} expected ${expected[suite].checksum}  ${Object.entries(seen).map(([l, c]) => `${l}=${c}`).join('  ')}  ${ok ? 'IDENTICAL' : 'MISMATCH'}`);
}

console.log(failed ? '\nVALIDATION FAILED' : '\nall implementations agree');
process.exit(failed ? 1 : 0);
