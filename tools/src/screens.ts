/**
 * Visual QA: drives the web app in headless Chrome and saves screenshots.
 *   node tools/src/screens.ts [baseUrl] [outDir]
 */
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? '/tmp/shots';
const browser = await chromium.launch({ executablePath: '/usr/sbin/google-chrome-stable', headless: true });
const errors: string[] = [];

async function shot(name: string, path: string, opts: { dark?: boolean; mobile?: boolean; act?: (p: import('playwright-core').Page) => Promise<void> } = {}) {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 },
    deviceScaleFactor: opts.mobile ? 2 : 1,
    colorScheme: opts.dark ? 'dark' : 'light',
    hasTouch: !!opts.mobile,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  if (opts.act) await opts.act(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await ctx.close();
}

const pages = (process.argv[4] ?? 'home,play,replay,runtimes,benchmarks,leaderboard,agents,history,watch').split(',');
if (pages.includes('home')) {
  await shot('home-light', '/');
  await shot('home-dark', '/', { dark: true });
  await shot('home-mobile', '/', { mobile: true, dark: true });
}
if (pages.includes('play')) {
  await shot('play', '/play?seed=42', {
    act: async (p) => {
      await p.waitForURL(/\/play\/[0-9A-Z]{26}/);
      for (const k of ['ArrowLeft', 'ArrowDown', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowDown']) {
        await p.keyboard.press(k);
        await p.waitForTimeout(140);
      }
      await p.getByRole('button', { name: 'Hint' }).click();
      await p.waitForTimeout(800);
    },
  });
  await shot('play-ai-dark', '/play?seed=7&ai=1', { dark: true, act: async (p) => { await p.waitForTimeout(4000); } });
  await shot('play-mobile', '/play?seed=3', { mobile: true, act: async (p) => { await p.waitForURL(/\/play\/.+/); await p.waitForTimeout(500); } });
}
if (pages.includes('replay')) await shot('replay', '/replay', {});
for (const name of ['runtimes', 'benchmarks', 'leaderboard', 'agents', 'history', 'watch']) {
  if (pages.includes(name)) await shot(name, `/${name}`, { dark: name === 'runtimes' });
}
if (pages.includes('runtimes')) await shot('runtimes-light', '/runtimes');
await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
