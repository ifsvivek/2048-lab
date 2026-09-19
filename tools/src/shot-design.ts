import { chromium, type Page } from 'playwright-core';
const BASE = process.argv[2] ?? 'http://localhost:5173';
const b = await chromium.launch({ executablePath: '/usr/sbin/google-chrome-stable' });
const errs: string[] = [];
async function scrollThrough(p: Page) {
  const h = await p.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 400) { await p.evaluate((yy) => scrollTo(0, yy), y); await p.waitForTimeout(120); }
  await p.waitForTimeout(1600);
  await p.evaluate(() => scrollTo(0, 0));
  await p.waitForTimeout(300);
}
async function shot(name: string, path: string, o: { dark?: boolean; mobile?: boolean; full?: boolean; act?: (p: Page) => Promise<void> } = {}) {
  const ctx = await b.newContext({ viewport: o.mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 }, colorScheme: o.dark ? 'dark' : 'light' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(name + ': ' + e.message));
  await p.goto(BASE + path, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  if (o.act) await o.act(p);
  if (o.full) await scrollThrough(p);
  await p.screenshot({ path: '/tmp/shots/' + name + '.png', fullPage: !!o.full });
  await ctx.close();
}
await shot('d-home-light', '/', { full: true });
await shot('d-home-dark', '/', { dark: true });
await shot('d-home-mobile', '/', { mobile: true, dark: true, full: true });
await shot('d-analytics-impact', '/analytics', { dark: true, act: async (p) => { await p.locator('#impact').scrollIntoViewIfNeeded(); await p.waitForTimeout(400); await scrollThrough(p); await p.locator('#impact').screenshot({ path: '/tmp/shots/d-impact.png' }); } });
await shot('d-replay', '/replay/EJDP-9PDW-9E6W', { act: async (p) => { await p.waitForTimeout(800); await p.mouse.move(400, 820); } });
await shot('d-404', '/nope-not-here');
await b.close();
console.log(errs.length ? errs.join('\n') : 'no page errors');
