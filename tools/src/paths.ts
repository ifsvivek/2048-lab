import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const specDir = join(repoRoot, 'spec');
export const resultsDir = join(repoRoot, 'results');
