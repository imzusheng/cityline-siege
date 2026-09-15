import puppeteer from 'puppeteer-core';
import { startServer, EDGE } from './serve.mjs';
const { server, port } = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__CITYLINE__ && window.__CITYLINE__.ready()', { timeout: 60000 });
await page.click('#btn-start');
await page.evaluate((turtle) => { window.__TURTLE__ = turtle; window.__REINF__ = true; }, process.argv[2] === 'turtle');
const report = await page.evaluate(() => {
  const C = window.__CITYLINE__;
  const w = C.world();
  const log = [];
  // split the garrison: a rifle line in front of each objective
  const assigned = window.__TURTLE__;
  const assign = assigned ? [{ obj: 0, x: -300, y: -150, w: 600 }] : [
    { obj: 0, x: -300, y: -150, w: 600 },
    { obj: 1, x: -220, y: 120, w: 440 },
    { obj: 2, x: 200, y: 60, w: 420 },
  ];
  for (let i = 0; i < assign.length; i++) {
    const a = assign[i];
    const o = w.city.objectives[a.obj];
    C.selectNear(o.x + a.x * 0.4, o.y + a.y * 0.4 + 130, 460);
    C.issue('hold', o.x + a.x, o.y + a.y, o.x + a.x + a.w, o.y + a.y);
  }
  for (let t = 0; t < 900; t += 30) {
    C.step(30);
    const s = C.snapshot();
    log.push({ t: Math.round(s.time), h: s.humans, z: s.zombies, k: s.kills, L: s.losses, obj: s.objectives.map(v => Math.round(v)), ended: s.ended });
    if (s.ended) break;
    if (s.humans < 96 && window.__REINF__) { window.__REINF__ = false; document.getElementById('btn-reinforce').click(); }
    if (s.humans < 60) { document.getElementById('btn-reinforce').click(); }
    if (s.time > 240 && s.humans < 70) C.selectAll();
  }
  return { log, final: C.snapshot(), orders: C.orderStats().length };
});
for (const row of report.log) console.log(JSON.stringify(row));
console.log('FINAL', JSON.stringify(report.final));
await browser.close(); server.close();
