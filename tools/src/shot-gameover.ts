import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/sbin/google-chrome-stable' });
for (const dark of [true, false]) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
  const p = await ctx.newPage();
  const errs: string[] = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:5173/play?seed=5');
  await p.waitForURL(/\/play\/[0-9A-Z]{26}/);
  const keys = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'];
  for (let i = 0; i < 800 && !(await p.getByRole('dialog', { name: 'Game over' }).isVisible()); i++) await p.keyboard.press(keys[(i * 7 + (i >> 2)) % 4]);
  await p.waitForTimeout(700);
  await p.locator('main').screenshot({ path: `/tmp/shots/gameover-${dark ? 'dark' : 'light'}.png` });
  console.log(dark ? 'dark' : 'light', 'errors:', errs.length ? errs : 'none');
  await ctx.close();
}
await b.close();
