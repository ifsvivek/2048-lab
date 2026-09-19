import { chromium } from 'playwright-core';
const BASE = 'https://2048.ifsvivek.in';
const b = await chromium.launch({ executablePath: '/usr/sbin/google-chrome-stable' });
const errs: string[] = [];
for (const [name, path, dark] of [['prod-home', '/', true], ['prod-replay', '/replay/DPDU-VUTK-7ABC', false], ['prod-runtimes', '/runtimes', false], ['prod-analytics', '/analytics', true]] as const) {
  const p = await (await b.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
  p.on('pageerror', (e) => errs.push(name + ': ' + e.message));
  const res = await p.goto(BASE + path, { waitUntil: 'networkidle' });
  if (name === 'prod-replay') { await p.getByRole('button', { name: 'Play', exact: true }).click(); await p.waitForTimeout(2500); }
  await p.waitForTimeout(800);
  await p.screenshot({ path: '/tmp/shots/' + name + '.png', fullPage: name !== 'prod-analytics' });
  console.log(name, res?.status());
}
await b.close();
console.log(errs.length ? errs.join('\n') : 'no page errors');
