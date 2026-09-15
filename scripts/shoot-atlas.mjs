import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { startServer, EDGE } from './serve.mjs';

const { server, port } = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 2600, height: 1400, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/?debug=${process.argv[2] ?? 'atlas'}`, { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: 'docs/shots/_atlas.png' });
fs.mkdirSync('docs/shots', { recursive: true });
await browser.close();
server.close();
console.log('shot ok');
