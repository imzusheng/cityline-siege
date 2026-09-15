// Minimal PNG reader (8-bit, non-interlaced) + ASCII preview, so screenshots can
// be inspected as text in a terminal-only workflow.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8;
  let width = 0, height = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth + ' unsupported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels) throw new Error('color type ' + colorType + ' unsupported');
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    raw.copy(cur, 0, p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      switch (filter) {
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 255; break;
        }
        default: break;
      }
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      if (channels === 4) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3]; }
      else if (channels === 3) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255; }
      else { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = channels === 2 ? cur[s + 1] : 255; }
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, data: out };
}

const RAMP = ' .:-=+*#%@';

export function ascii(img, cols = 110, rows = 0, opts = {}) {
  const aspect = 2.05;
  if (!rows) rows = Math.max(6, Math.round((cols * img.height / img.width) / aspect));
  const { data, width, height } = img;
  const lines = [];
  const ramp = opts.ramp ?? RAMP;
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c / cols) * width), x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * width));
      const y0 = Math.floor((r / rows) * height), y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * height));
      let l = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * width + x) * 4;
        l += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        n++;
      }
      const v = n ? l / n / 255 : 0;
      line += ramp[Math.min(ramp.length - 1, Math.max(0, Math.floor(v * ramp.length)))];
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

export function colorMap(img, cols = 110, rows = 0) {
  const aspect = 2.05;
  if (!rows) rows = Math.max(6, Math.round((cols * img.height / img.width) / aspect));
  const { data, width, height } = img;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c / cols) * width), x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * width));
      const y0 = Math.floor((r / rows) * height), y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * height));
      let R = 0, G = 0, B = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * width + x) * 4;
        R += data[i]; G += data[i + 1]; B += data[i + 2]; n++;
      }
      if (!n) { line += ' '; continue; }
      R /= n; G /= n; B /= n;
      const l = (R + G + B) / 3;
      if (l < 26) line += 'K';
      else if (l > 190) line += 'W';
      else if (G > R + 12 && G > B + 12) line += 'g';
      else if (R > G + 18 && R > B + 18) line += 'r';
      else if (B > R + 12) line += 'b';
      else if (R > 120 && G > 110) line += 'y';
      else line += (l > 120 ? 'o' : '.');
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

export function regionStats(img, x0, y0, x1, y1) {
  const { data, width } = img;
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    R += data[i]; G += data[i + 1]; B += data[i + 2]; n++;
  }
  return { r: R / n, g: G / n, b: B / n, n };
}
