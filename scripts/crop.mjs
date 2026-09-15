import { decodePNG, ascii, colorMap } from './png.mjs';
const [, , file, cx, cy, cw, ch, cols, mode] = process.argv;
const img = decodePNG(file);
const x0 = Math.max(0, Math.min(img.width - 1, Number(cx)));
const y0 = Math.max(0, Math.min(img.height - 1, Number(cy)));
const w = Math.min(Number(cw), img.width - x0);
const h = Math.min(Number(ch), img.height - y0);
const sub = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
for (let y = 0; y < h; y++) {
  img.data.copy(sub.data, y * w * 4, ((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + w) * 4);
}
console.log(`# ${file} crop ${x0},${y0} ${w}x${h}`);
const n = Number(cols) || 120;
console.log(mode === 'color' ? colorMap(sub, n) : ascii(sub, n));
