import puppeteer from 'puppeteer-core';
import { startServer, EDGE } from './serve.mjs';
const { server, port } = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__CITYLINE__ && window.__CITYLINE__.ready()', { timeout: 60000 });
const f = await page.evaluate(() => {
  const C = window.__CITYLINE__;
  const w = C.world();
  const r = C.renderer();
  const arch = {};
  let maxH = 0, sumH = 0;
  for (const b of w.city.buildings) { arch[b.arch.id] = (arch[b.arch.id] ?? 0) + 1; maxH = Math.max(maxH, b.height); sumH += b.height; }
  let blocked = 0;
  for (let i = 0; i < w.nav.blocked.length; i++) if (w.nav.blocked[i]) blocked++;
  return {
    buildings: w.city.buildings.length, maxH: Math.round(maxH), meanH: Math.round(sumH / w.city.buildings.length),
    arch, roads: w.city.roads.length, trees: w.city.trees.length, barricades: w.city.barricades.length,
    objectives: w.city.objectives.map(o => o.name), districts: w.city.districts.map(d => d.name),
    navCells: w.nav.blocked.length, navBlocked: blocked,
    meshVerts: r.buildCount, humans: w.humans.length,
  };
});
console.log(JSON.stringify(f, null, 1));
await browser.close(); server.close();
