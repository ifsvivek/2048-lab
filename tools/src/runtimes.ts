/** How to invoke each language implementation's CLI from the repo root. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './paths.ts';

export interface Runtime {
  language: 'typescript' | 'rust' | 'go' | 'python';
  cwd: string;
  /** argv prefix for the CLI */
  cmd: string[];
  /** one-time build step (null = none) */
  build: string[] | null;
  available: () => boolean;
}

const which = (bin: string) => {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const cargo = existsSync(join(homedir(), '.cargo/bin/cargo')) ? join(homedir(), '.cargo/bin/cargo') : 'cargo';

export const RUNTIMES: Runtime[] = [
  {
    language: 'typescript',
    cwd: repoRoot,
    cmd: ['node', join(repoRoot, 'tools/src/ts-cli.ts')],
    build: null,
    available: () => true,
  },
  {
    language: 'rust',
    cwd: join(repoRoot, 'engines/rust'),
    cmd: [join(repoRoot, 'engines/rust/target/release/g2048')],
    build: [cargo, 'build', '--release', '--quiet'],
    available: () => which('cargo') || existsSync(cargo),
  },
  {
    language: 'go',
    cwd: join(repoRoot, 'engines/go'),
    cmd: [join(repoRoot, 'engines/go/bin/g2048')],
    build: ['go', 'build', '-o', 'bin/g2048', './cmd/g2048'],
    available: () => which('go'),
  },
  {
    language: 'python',
    cwd: join(repoRoot, 'engines/python'),
    cmd: ['uv', 'run', '--quiet', 'g2048'],
    build: ['uv', 'sync', '--quiet'],
    available: () => which('uv'),
  },
];

export function selected(arg: string | undefined): Runtime[] {
  const want = arg ? arg.split(',') : null;
  return RUNTIMES.filter((r) => (!want || want.includes(r.language)) && r.available());
}

export function build(r: Runtime): void {
  if (!r.build) return;
  execFileSync(r.build[0], r.build.slice(1), { cwd: r.cwd, stdio: 'inherit' });
}
