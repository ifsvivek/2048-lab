import { chromium } from 'playwright-core';
const BASE = 'https://g2048-web.ifsvivek.workers.dev';
const b = await chromium.launch({ executablePath: '/usr/sbin/google-chrome-stable' });
const errs: string[] = [];
const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'light' });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE + '/analytics', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
await p.locator('#impact').scrollIntoViewIfNeeded();
for (let y = 0; y < 3000; y += 300) { await p.mouse.wheel(0, 300); await p.waitForTimeout(80); }
await p.waitForTimeout(1500);
await p.locator('#impact').screenshot({ path: '/tmp/shots/prod-impact.png' });
await p.goto(BASE + '/', { waitUntil: 'networkidle' });
await p.waitForTimeout(3500);
await p.screenshot({ path: '/tmp/shots/prod-home2.png' });
await b.close();
console.log(errs.length ? errs : 'no page errors');
