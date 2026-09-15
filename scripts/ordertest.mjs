import puppeteer from 'puppeteer-core';
import { startServer, EDGE } from './serve.mjs';
const { server, port } = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 700 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__CITYLINE__ && window.__CITYLINE__.ready()', { timeout: 60000 });
await page.click('#btn-start');
const r = await page.evaluate(() => {
  const C = window.__CITYLINE__;
  const out = [];
  const w = C.world();
  const o = w.city.objectives[0];
  // keep the test away from the horde
  C.step(1);
  C.selectNear(o.x, o.y + 150, 220);
  out.push({ step: 'selected', snap: C.snapshot() });
  // hold a line well east of the group
  C.issue('hold', o.x + 340, o.y - 120, o.x + 340, o.y + 220);
  out.push({ step: 'ordered', orders: C.orderStats() });
  C.step(12);
  out.push({ step: 'after-12s-hold', orders: C.orderStats() });
  C.step(12);
  out.push({ step: 'after-24s-hold', orders: C.orderStats() });
  // fallback: pull them back 400 units
  C.issue('fallback', o.x - 380, o.y - 80, o.x - 380, o.y + 200);
  C.step(4);
  out.push({ step: 'fallback-4s', orders: C.orderStats() });
  C.step(14);
  out.push({ step: 'fallback-18s', orders: C.orderStats() });
  // force move
  C.issue('force', o.x + 60, o.y + 420, o.x + 360, o.y + 420);
  C.step(6);
  out.push({ step: 'force-6s', orders: C.orderStats() });
  // advance
  C.issue('advance', o.x - 200, o.y + 40, o.x + 200, o.y + 40);
  C.step(10);
  out.push({ step: 'advance-10s', orders: C.orderStats() });
  return out;
});
console.log(JSON.stringify(r, null, 1).slice(0, 4000));
await browser.close(); server.close();
