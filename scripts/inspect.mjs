import puppeteer from 'puppeteer-core';
import { startServer, EDGE } from './serve.mjs';

const mode = process.argv[2] ?? 'atlas';
const { server, port } = await startServer();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const query = process.argv[3] ?? 'debug=atlas';
await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 1200));

const out = await page.evaluate((mode, argsJson) => {
  const args = JSON.parse(argsJson);
  const A = window.__ATLAS__;
  if (!A) return 'no atlas';
  const canvas = mode === 'props' ? A.propCanvas : A.unitCanvas;
  const ctx = canvas.getContext('2d');
  const cols = args.cols ?? 48, rows = args.rows ?? 24;
  const ramp = ' .:-=+*#%@';
  function dump(sx, sy, sw, sh) {
    const img = ctx.getImageData(sx, sy, sw, sh).data;
    const lines = [];
    if (args.sil) {
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          let a = 0, n = 0;
          const x0 = Math.floor((c / cols) * sw), x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * sw));
          const y0 = Math.floor((r / rows) * sh), y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * sh));
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { a += img[(y * sw + x) * 4 + 3] / 255; n++; }
          a /= n;
          line += a > 0.72 ? '#' : a > 0.4 ? '+' : a > 0.12 ? '.' : ' ';
        }
        lines.push(line.replace(/\s+$/, ''));
      }
      return lines.join('\n');
    }
    if (args.color) {
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          let a = 0, R = 0, G = 0, Bl = 0, n = 0;
          const x0 = Math.floor((c / cols) * sw), x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * sw));
          const y0 = Math.floor((r / rows) * sh), y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * sh));
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = (y * sw + x) * 4;
            const al = img[i + 3] / 255;
            a += al; R += img[i] * al; G += img[i + 1] * al; Bl += img[i + 2] * al; n++;
          }
          a /= n;
          if (a < 0.35) { line += ' '; continue; }
          R /= n; G /= n; Bl /= n;
          const l = (R + G + Bl) / 3 / Math.max(0.05, a);
          if (l < 30) line += 'K';
          else if (l > 150) line += 'W';
          else if (R > G + 22 && R > Bl + 22) line += 'S';       // skin / warm
          else if (G > R + 8 && G > Bl + 8) line += 'G';
          else if (Bl > R + 8) line += 'B';
          else line += 'o';
        }
        lines.push(line.replace(/\s+$/, ''));
      }
      return lines.join('\n');
    }
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        let a = 0, l = 0, n = 0;
        const x0 = Math.floor((c / cols) * sw), x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * sw));
        const y0 = Math.floor((r / rows) * sh), y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * sh));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          const al = img[i + 3] / 255;
          a += al; l += al * (0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]) / 255; n++;
        }
        a /= n; l /= n;
        if (a < 0.25) line += ' ';
        else {
          const v = Math.min(0.999, Math.max(0, l / Math.max(0.08, a)));
          line += ramp[Math.min(ramp.length - 1, Math.floor(v * ramp.length))];
        }
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }
  if (mode === 'cell') {
    const list = args.cells ?? [];
    const parts = [];
    for (const cell of list) {
      const cx = (cell % 32) * 96, cy = Math.floor(cell / 32) * 96;
      parts.push('--- cell ' + cell + ' (type ' + Math.floor(cell / 120) + ') col/row ' + (cell % 32) + ',' + Math.floor(cell / 32) + ' ---');
      parts.push(dump(cx, cy, 96, 96));
    }
    return parts.join('\n');
  }
  if (mode === 'props') {
    const parts = [];
    for (let i = 0; i < 25; i++) {
      if (!args.only || args.only.includes(i)) {
        parts.push('--- prop ' + i + ' ---');
        parts.push(dump((i % 5) * 384, Math.floor(i / 5) * 384, 384, 384));
      }
    }
    return parts.join('\n');
  }
  return 'unknown mode';
}, mode, JSON.stringify({
  cells: (process.argv[4] ?? '').split(',').filter(Boolean).map(Number),
  cols: Number(process.argv[5] ?? 48),
  rows: Number(process.argv[6] ?? 24),
  only: (process.argv[4] ?? '').split(',').filter(Boolean).map(Number),
  sil: process.argv.includes('sil'),
  color: process.argv.includes('color'),
}));
console.log(out);
await browser.close();
server.close();
