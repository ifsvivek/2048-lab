import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/sbin/google-chrome-stable' });
for (const dark of [false, true]) {
  const p = await (await b.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
  const errs: string[] = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:5173/analytics', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `/tmp/shots/analytics-${dark ? 'dark' : 'light'}.png`, fullPage: true });
  console.log(dark, errs);
}
await b.close();
