import puppeteer from 'puppeteer-core';
import { startServer, EDGE } from './serve.mjs';
const { server, port } = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__CITYLINE__ && window.__CITYLINE__.ready()', { timeout: 60000 });
await page.click('#btn-start');
await page.evaluate(() => window.__CITYLINE__.selectAll());
await page.evaluate(() => window.__CITYLINE__.issue('hold', 2600, 2200, 3400, 2200));
await page.evaluate(() => window.__CITYLINE__.step(40));
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const hud = await page.evaluate(() => ({
  humans: document.getElementById('s-humans').textContent,
  zombies: document.getElementById('s-zombies').textContent,
  time: document.getElementById('s-time').textContent,
  selVisible: !document.getElementById('sel-panel').classList.contains('hidden'),
  selN: document.getElementById('sel-n').textContent,
  selState: document.getElementById('sel-state').textContent,
  objectives: document.querySelectorAll('#obj-block .obj').length,
  toasts: document.querySelectorAll('#toasts .toast').length,
  fps: document.getElementById('s-fps').textContent,
}));
console.log('HUD', JSON.stringify(hud));
await page.screenshot({ path: 'docs/shots/_hud.png' });
// force the end screen
await page.evaluate(() => { const w = window.__CITYLINE__.world(); for (const o of w.city.objectives) { o.hp = 0; o.lost = true; } window.__CITYLINE__.step(2); });
await new Promise(r => setTimeout(r, 400));
const res = await page.evaluate(() => ({
  visible: !document.getElementById('result').classList.contains('hidden'),
  title: document.getElementById('result-title').textContent,
  stats: document.getElementById('result-stats').textContent,
}));
console.log('RESULT', JSON.stringify(res));
await page.screenshot({ path: 'docs/shots/_result.png' });
await page.click('#btn-restart');
await new Promise(r => setTimeout(r, 1500));
const after = await page.evaluate(() => ({ snap: window.__CITYLINE__.snapshot(), splash: document.getElementById('splash').classList.contains('hidden'), result: document.getElementById('result').classList.contains('hidden') }));
console.log('AFTER-RESTART', JSON.stringify(after));
console.log('errors', JSON.stringify(errs.filter(e => !e.includes('favicon'))));
await browser.close(); server.close();
