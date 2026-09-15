import puppeteer from 'puppeteer-core';
import { startServer, EDGE } from './serve.mjs';
const { server, port } = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__CITYLINE__ && window.__CITYLINE__.ready()', { timeout: 60000 });
const info = await page.evaluate(() => {
  const r = window.__CITYLINE__.renderer();
  const w = window.__CITYLINE__.world();
  return {
    buildings: w.city.buildings.length,
    roads: w.city.roads.length,
    trees: w.city.trees.length,
    objectives: w.city.objectives.length,
    meshVerts: r.buildCount,
    cities: { w: 6400, h: 4800 },

  };
});
console.log(JSON.stringify(info));
await page.click('#btn-start');
const shots = JSON.parse(process.argv[2] ?? '[]');
for (const s of shots) {
  await page.evaluate((s) => {
    window.__CITYLINE__.camera(s.x, s.y, s.z);
    if (s.rot !== undefined) window.__CITYLINE__.rotate(s.rot);
    if (s.step) window.__CITYLINE__.step(s.step);
    if (s.passes) window.__CITYLINE__.passes(s.passes);
    if (s.follow) {
      const p = s.follow === 'zombie' ? window.__CITYLINE__.firstZombie() : window.__CITYLINE__.firstHuman();
      window.__CITYLINE__.camera(p.x, p.y, s.z ?? 8);
    }
    if (s.densest) {
      const p = window.__CITYLINE__.densest();
      window.__CITYLINE__.camera(p.x, p.y, s.z ?? 3);
    }
  }, s);
  await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
  const opts = { path: `docs/shots/${s.name}.png` };
  if (s.clip) opts.clip = s.clip;
  await page.screenshot(opts);
  console.log('shot', s.name, JSON.stringify(await page.evaluate(() => window.__CITYLINE__.snapshot())));
}
await browser.close(); server.close();
