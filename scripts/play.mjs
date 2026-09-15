// Headless playtest harness.
//   node scripts/play.mjs <scenario> [outdir]
// Drives the real game through the __CITYLINE__ automation surface, captures
// screenshots and reports console/page errors plus FPS samples.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, EDGE } from './serve.mjs';

const scenario = process.argv[2] ?? 'smoke';
const outDir = process.argv[3] ?? 'docs/shots';
fs.mkdirSync(outDir, { recursive: true });

const { server, port } = await startServer();
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', '--window-size=1600,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
const errors = [];
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__CITYLINE__ && window.__CITYLINE__.ready()', { timeout: 60000 });
await new Promise(r => setTimeout(r, 400));

const shots = [];
async function shot(name) {
  const p = path.join(outDir, name + '.png');
  await page.screenshot({ path: p });
  shots.push(p);
  return p;
}
async function step(sec) {
  await page.evaluate((s) => window.__CITYLINE__.step(s), sec);
}
async function settle(frames = 3) {
  await page.evaluate((n) => new Promise(res => {
    let i = 0;
    const tick = () => { i++; if (i >= n) res(true); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), frames);
}
const snap = () => page.evaluate(() => window.__CITYLINE__.snapshot());

async function measureFps(seconds) {
  return page.evaluate((sec) => new Promise(res => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      const el = (performance.now() - t0) / 1000;
      if (el >= sec) res(frames / el);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), seconds);
}

const results = { scenario, errors, shots: [], snapshots: {}, fps: [] };

async function run() {
  if (scenario === 'smoke') {
    await shot('00-splash');
    await page.click('#btn-start');
    await settle(20);
    await shot('01-initial');
    await step(20);
    await settle(3);
    results.snapshots.t20 = await snap();
    await shot('02-t20');
    await step(60);
    await settle(3);
    results.snapshots.t80 = await snap();
    await shot('03-t80');
  } else if (scenario === 'shots') {
    await page.click('#btn-start');
    await settle(20);

    // 01 — the whole city from the strategic layer
    await page.evaluate(() => { window.__CITYLINE__.camera(3200, 2400, 0.13); });
    await step(28);
    await settle(20);
    await shot('01-city-overview');
    results.snapshots.overview = await snap();

    // deploy: 84 men on a line covering the north approach to city hall
    await page.evaluate(() => {
      const C = window.__CITYLINE__;
      const w = C.world();
      const o = w.city.objectives[0];
      C.selectNear(o.x, o.y - 180, 400);
      C.issue('hold', o.x - 300, o.y - 60, o.x + 300, o.y - 60);
    });
    await step(26);
    await settle(20);
    await page.evaluate(() => { window.__CITYLINE__.camera(2965, 2130, 3.2); });
    await settle(22);
    await shot('02-defense-line');
    results.snapshots.line = await snap();
    results.orders = await page.evaluate(() => window.__CITYLINE__.orderStats());

    // the horde: find where the infected mass is thickest but not yet fighting
    await page.evaluate(() => {
      const C = window.__CITYLINE__;
      const p = C.densest();
      C.camera(p.x, p.y, 0.62);
    });
    await settle(22);
    await shot('03-zombie-horde');
    results.snapshots.horde = await snap();

    // run until the lines are actually in contact
    await page.evaluate(() => window.__CITYLINE__.step(150));
    await settle(20);
    await page.evaluate(() => {
      const C = window.__CITYLINE__;
      const p = C.contact();
      C.camera(p.x, p.y, 3.6);
    });
    await settle(22);
    await shot('04-contact');
    results.snapshots.contact = await snap();

    // let the line buckle, then photograph the break
    await page.evaluate(() => window.__CITYLINE__.step(180));
    await settle(20);
    await page.evaluate(() => {
      const C = window.__CITYLINE__;
      const p = C.contact();
      C.camera(p.x, p.y, 1.35);
    });
    await settle(22);
    await shot('05-breach');
    results.snapshots.breach = await snap();

    // close-up: men and zombies at arm's length next to real buildings
    await page.evaluate(() => {
      const C = window.__CITYLINE__;
      const w = C.world();
      // stand where a squad is trading blows: frame both soldiers and infected
      let best = null, bn = -1, bx = 0, by = 0, bc = 0;
      for (const h of w.humans) {
        if (!h.alive) continue;
        let n = 0, sx = 0, sy = 0, c = 0;
        w.hashZ.forEachNear(h.x, h.y, 70, (i) => {
          const z = w.zombies[i];
          if (!z || !z.alive) return;
          n++; sx += z.x; sy += z.y; c++;
        });
        if (n > bn) { bn = n; best = h; bx = c ? sx / c : h.x; by = c ? sy / c : h.y; bc = c; }
      }
      if (best) C.camera((best.x + bx) / 2, (best.y + by) / 2, 7);
      window.__CLOSE_INFO__ = { zombies: bn, at: best ? [Math.round(best.x), Math.round(best.y)] : null };
    });
    await settle(22);
    await shot('06-close-up');
    results.snapshots.closeup = await snap();
    results.closeInfo = await page.evaluate(() => window.__CLOSE_INFO__);
    results.fps.push(await measureFps(5));
  } else if (scenario === 'qa') {
    await page.click('#btn-start');
    await settle(20);
    await shot('01-city-overview');
    results.snapshots.overview = await snap();

    // select 20 men and draw a short line
    await page.evaluate(() => {
      const w = window.__CITYLINE__.world();
      const o = w.city.objectives[0];
      window.__CITYLINE__.camera(o.x, o.y + 300, 1.6);
    });
    await settle(3);
    await page.evaluate(() => {
      const w = window.__CITYLINE__.world();
      const o = w.city.objectives[0];
      window.__CITYLINE__.selectNear(o.x - 60, o.y + 150, 90);
    });
    await settle(2);
    await shot('02-selected');
    results.snapshots.selected = await snap();

    await page.evaluate(() => {
      const w = window.__CITYLINE__.world();
      const o = w.city.objectives[0];
      window.__CITYLINE__.issue('hold', o.x - 170, o.y + 90, o.x + 170, o.y + 90);
    });
    await step(3);
    await settle(3);
    await shot('03-defense-line');

    await page.evaluate(() => window.__CITYLINE__.selectAll());
    await page.evaluate(() => {
      const w = window.__CITYLINE__.world();
      const o = w.city.objectives[0];
      window.__CITYLINE__.issue('hold', o.x - 320, o.y + 20, o.x + 320, o.y + 20);
    });
    await step(5);
    await settle(3);
    await shot('04-long-line');

    await step(120);
    await settle(3);
    await shot('05-horde');
    results.snapshots.horde = await snap();

    await step(180);
    await settle(3);
    await shot('06-contact');
    results.snapshots.contact = await snap();
  } else if (scenario === 'perf') {
    await page.click('#btn-start');
    await settle(20);
    const measure = async (label, prep) => {
      if (prep) await prep();
      await settle(22);
      const s = await snap();
      const fps = await measureFps(5);
      results.fps.push({ label, fps: Number(fps.toFixed(1)), units: s.humans + s.zombies, corpses: s.corpses, zoom: Number(s.zoom.toFixed(2)), time: Math.round(s.time) });
      console.log(label, 'fps', fps.toFixed(1), 'units', s.humans + s.zombies, 'corpses', s.corpses, 'zoom', s.zoom.toFixed(2));
    };
    await measure('t0-strategic', async () => { await page.evaluate(() => window.__CITYLINE__.camera(3200, 2400, 0.13)); });
    await measure('t0-tactical', async () => { await page.evaluate(() => window.__CITYLINE__.camera(2965, 2130, 1.5)); });
    await measure('t0-closeup', async () => { await page.evaluate(() => window.__CITYLINE__.camera(2965, 2130, 10)); });
    await page.evaluate(() => { const C = window.__CITYLINE__; const w = C.world(); const o = w.city.objectives[0]; C.selectNear(o.x, o.y - 180, 420); C.issue('hold', o.x - 320, o.y - 40, o.x + 320, o.y - 40); });
    await step(180);
    await measure('t180-mid', async () => { await page.evaluate(() => { const p = window.__CITYLINE__.contact(); window.__CITYLINE__.camera(p.x, p.y, 2.0); }); });
    await step(240);
    await measure('t420-late', async () => { await page.evaluate(() => { const p = window.__CITYLINE__.contact(); window.__CITYLINE__.camera(p.x, p.y, 1.4); }); });
    await measure('t420-strategic', async () => { await page.evaluate(() => window.__CITYLINE__.camera(3200, 2400, 0.13)); });
    await step(240);
    await measure('t660-late', async () => { await page.evaluate(() => { const p = window.__CITYLINE__.contact(); window.__CITYLINE__.camera(p.x, p.y, 1.4); }); });
    results.snapshots.final = await snap();
  }

  results.shots = shots;
  results.finalSnap = await snap();
  fs.writeFileSync(path.join(outDir, '..', `play-${scenario}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ scenario, errors, snapshots: results.snapshots, fps: results.fps, shots }, null, 1));
  if (logs.length) {
    const interesting = logs.filter(l => !l.startsWith('[vite]')).slice(0, 12);
    if (interesting.length) console.log('--- console ---\n' + interesting.join('\n'));
  }
}

try { await run(); } catch (e) { console.log('HARNESS ERROR', e.message); }
await browser.close();
server.close();
