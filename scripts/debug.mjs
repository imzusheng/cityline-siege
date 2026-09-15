import puppeteer from 'puppeteer-core';
import { startServer, EDGE } from './serve.mjs';
const { server, port } = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 700 });
page.on('console', (m) => console.log('[' + m.type() + ']', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message, '\n', e.stack));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 8000));
const state = await page.evaluate(() => ({
  has: !!window.__CITYLINE__,
  ready: window.__CITYLINE__ ? window.__CITYLINE__.ready() : null,
  fatal: document.getElementById('fatal')?.innerHTML?.slice(0, 500),
  load: document.getElementById('load-line')?.textContent,
}));
console.log(JSON.stringify(state, null, 1));
await browser.close(); server.close();
