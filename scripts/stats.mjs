import { decodePNG, regionStats } from './png.mjs';
const img = decodePNG(process.argv[2]);
const { data, width, height } = img;
const hist = new Array(16).fill(0);
let sum = 0;
for (let i = 0; i < data.length; i += 4) {
  const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  hist[Math.min(15, l >> 4)]++;
  sum += l;
}
const n = data.length / 4;
console.log(process.argv[2], width + 'x' + height, 'mean luma', (sum / n).toFixed(1));
const max = Math.max(...hist);
console.log('hist', hist.map((v, i) => (i * 16) + ':' + (100 * v / n).toFixed(1) + '%').join(' '));
console.log('centre', JSON.stringify(regionStats(img, (width * 0.4) | 0, (height * 0.4) | 0, (width * 0.6) | 0, (height * 0.6) | 0)));
