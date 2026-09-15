import { decodePNG, ascii, colorMap } from './png.mjs';
const file = process.argv[2];
const cols = Number(process.argv[3] ?? 110);
const rows = Number(process.argv[4] ?? 0);
const mode = process.argv[5] ?? 'lum';
const img = decodePNG(file);
console.log(`# ${file} ${img.width}x${img.height}`);
console.log(mode === 'color' ? colorMap(img, cols, rows) : ascii(img, cols, rows));
