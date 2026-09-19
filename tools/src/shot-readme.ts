import { chromium, type Page } from 'playwright-core';
const BASE = 'https://2048.ifsvivek.in';
const OUT = '/home/ifsvivek/Projects/2048/docs/images';
const b = await chromium.launch({ executablePath: '/usr/sbin/google-chrome-stable' });
async function shot(name: string, path: string, o: { dark?: boolean; mobile?: boolean; act?: (p: Page) => Promise<void>; clip?: boolean } = {}) {
  const ctx = await b.newContext({ viewport: o.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: o.dark ? 'dark' : 'light', hasTouch: !!o.mobile });
  const p = await ctx.newPage();
  await p.goto(BASE + path, { waitUntil: 'networkidle' });
  if (o.act) await o.act(p);
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 78 });
  await ctx.close();
  console.log(name);
}
await shot('home', '/', { dark: true, act: async (p) => p.waitForTimeout(3000) });
await shot('play-ai', '/play?seed=31&ai=1', { dark: true, act: async (p) => { await p.waitForURL(/\/play\/.+/); await p.waitForTimeout(9000); } });
await shot('replay', '/replay/DPDU-VUTK-7ABC', { act: async (p) => { await p.getByRole('button', { name: 'Play', exact: true }).click(); await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(4000); await p.evaluate(() => window.scrollTo(0, 0)); } });
await shot('runtimes', '/runtimes', { act: async (p) => { await p.getByRole('button', { name: 'engine-random-10k' }).click(); await p.waitForTimeout(2500); } });
await shot('analytics', '/analytics', { dark: true });
await shot('mobile', '/play?seed=9', { mobile: true, dark: true, act: async (p) => { await p.waitForURL(/\/play\/.+/); for (const k of ['ArrowDown','ArrowLeft','ArrowDown','ArrowRight','ArrowDown','ArrowLeft','ArrowDown','ArrowLeft']) { await p.keyboard.press(k); await p.waitForTimeout(150); } } });
await b.close();
