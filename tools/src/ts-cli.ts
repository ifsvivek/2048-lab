/**
 * TypeScript CLI with the same interface as the Rust/Go/Python CLIs:
 *   validate [--json]            bench --suite PATH [--out FILE]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, arch, platform, totalmem, type } from 'node:os';
import { type BenchmarkSuite, runSuite } from '@g2048/engine/sim';
import { runFixtureChecks } from './ts-fixtures.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (cmd === 'bench') {
  const path = flag('suite');
  if (!path) throw new Error('--suite required');
  const suite = JSON.parse(readFileSync(path, 'utf8')) as BenchmarkSuite;
  let peakRss = process.memoryUsage().rss;
  const result = await runSuite(suite, {
    implementation: { language: 'typescript', runtime: 'node', runtimeVersion: process.version, engineVersion: '1.0.0', platform: platform() },
    environment: { os: type(), arch: arch(), cpus: cpus().length, cpu: cpus()[0]?.model ?? 'unknown', memoryBytes: totalmem(), ttPolicy: 'reference' },
    memory: () => (peakRss = Math.max(peakRss, process.memoryUsage().rss)),
    cpuMs: () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    },
    onGame: (g, i) => process.stderr.write(`\r[typescript] ${suite.id} game ${i + 1}/${suite.seeds.count} score ${g.score}      `),
  });
  // resourceUsage().maxRSS is the true process peak (KB).
  result.summary.peakMemoryBytes = Math.max(result.summary.peakMemoryBytes ?? 0, process.resourceUsage().maxRSS * 1024);
  process.stderr.write('\n');
  const json = JSON.stringify(result, null, 2);
  const out = flag('out');
  if (out) writeFileSync(out, json);
  else process.stdout.write(json + '\n');
} else if (cmd === 'validate') {
  const r = await runFixtureChecks();
  if (rest.includes('--json')) console.log(JSON.stringify({ language: 'typescript', ...r }));
  else console.log(`typescript: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed ? 1 : 0);
} else {
  console.error('usage: ts-cli.ts validate [--json] | bench --suite PATH [--out FILE]');
  process.exit(2);
}
