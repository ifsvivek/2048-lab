import { chromium, type Page } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/sbin/google-chrome-stable' });
const errs: string[] = [];
async function run(name: string, o: { dark?: boolean; mobile?: boolean }) {
  const ctx = await b.newContext({ viewport: o.mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 }, colorScheme: o.dark ? 'dark' : 'light' });
  const p: Page = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(name + ': ' + e.message));
  await p.goto('https://2048.ifsvivek.in/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `/tmp/shots/${name}-fold.png` });
  const h = await p.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 350) { await p.evaluate((yy) => scrollTo(0, yy), y); await p.waitForTimeout(110); }
  await p.waitForTimeout(1800);
  await p.evaluate(() => scrollTo(0, 0));
  await p.waitForTimeout(300);
  await p.screenshot({ path: `/tmp/shots/${name}-full.png`, fullPage: true });
  await ctx.close();
}
await run('t-light', {});
await run('t-dark', { dark: true });
await run('t-mobile', { mobile: true });
await b.close();
console.log(errs.length ? errs.join('\n') : 'no page errors');
