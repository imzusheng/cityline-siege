// Procedural texture assets.
//
//   * a 32-layer 2D texture array: 8 wall styles x 3 wear states (intact /
//     worn / damaged) + 5 street-level bands + 3 roofs
//   * a tiling detail texture that keeps pavement crisp at close zoom
//   * one baked ground map covering the whole 6400x4800 world (roads, parks,
//     plazas, scorch marks and every building shadow), painted once at boot

import type { GL } from './glutil';
import { WORLD_W, WORLD_H } from '../core/config';
import { Rng, clamp, lerp } from '../core/math';
import type { City } from '../map/city';

export const FACADE_SIZE = 256;
export const FACADE_LAYERS = 32;

/** Wall layer = variant * 8 + style. */
export const WALL_STYLE: Record<string, number> = {
  brick: 0, concrete: 1, panel: 2, glass: 3, metal: 4, hospital: 5, stone: 6, derelict: 7,
};
export const VARIANT = { intact: 0, worn: 1, damaged: 2 } as const;
export const LAYER = {
  gLobby: 24, gShop: 25, gLoading: 26, gClinic: 27, gShutter: 28,
  rGravel: 29, rTar: 30, rMetal: 31,
} as const;

export function wallLayer(style: number, variant: number): number { return variant * 8 + style; }
export const GROUND_LAYER: Record<string, number> = {
  lobby: LAYER.gLobby, shopfront: LAYER.gShop, warehouse: LAYER.gLoading, loading: LAYER.gLoading,
  clinic: LAYER.gClinic, civic: LAYER.gLobby, entry: LAYER.gShutter, shutter: LAYER.gShutter,
};
export const ROOF_LAYER: Record<string, number> = {
  gravel: LAYER.rGravel, tar: LAYER.rTar, metal: LAYER.rMetal, tile: LAYER.rTar,
};

const S = FACADE_SIZE;
type DCtx = CanvasRenderingContext2D;

function tile(): { c: HTMLCanvasElement; x: DCtx } {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const x = c.getContext('2d')!;
  return { c, x };
}

function grain(x: DCtx, rng: Rng, amount: number): void {
  for (let i = 0; i < 5200; i++) {
    const v = rng.range(-amount, amount);
    x.fillStyle = v > 0 ? `rgba(255,255,255,${v.toFixed(3)})` : `rgba(0,0,0,${(-v).toFixed(3)})`;
    x.fillRect(rng.range(0, S), rng.range(0, S), 2, 2);
  }
}

/** vertical grime streaks running down from the top of the tile */
function grime(x: DCtx, rng: Rng, count: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const wx = rng.range(0, S), len = rng.range(S * 0.25, S), w = rng.range(3, 16);
    const g = x.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, `rgba(28,26,22,${alpha.toFixed(3)})`);
    g.addColorStop(1, 'rgba(28,26,22,0)');
    x.fillStyle = g;
    x.fillRect(wx - w / 2, 0, w, len);
    if (wx < w) x.fillRect(wx - w / 2 + S, 0, w, len);
    if (wx > S - w) x.fillRect(wx - w / 2 - S, 0, w, len);
  }
}

function cracks(x: DCtx, rng: Rng, count: number, dark: string, lw: number): void {
  x.strokeStyle = dark;
  x.lineWidth = lw;
  x.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    let px = rng.range(0, S), py = rng.range(0, S * 0.75);
    x.beginPath();
    x.moveTo(px, py);
    const segs = rng.int(3, 7);
    for (let k = 0; k < segs; k++) {
      px += rng.range(-26, 26); py += rng.range(6, 30);
      x.lineTo(px, py);
    }
    x.stroke();
  }
}

function spall(x: DCtx, rng: Rng, count: number, base: string, ox = S * 0.5, oy = S * 0.5, spread = S * 0.34): void {
  for (let i = 0; i < count; i++) {
    x.fillStyle = base;
    x.beginPath();
    const a0 = rng.range(0, 6.283), d0 = Math.sqrt(rng.next()) * spread;
    const cx = ox + Math.cos(a0) * d0, cy = oy + Math.sin(a0) * d0 * 0.85, r = rng.range(5, 18);
    for (let k = 0; k <= 7; k++) {
      const a = (k / 7) * 6.283;
      const rr = r * rng.range(0.55, 1.3);
      const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
      if (k === 0) x.moveTo(px, py); else x.lineTo(px, py);
    }
    x.closePath(); x.fill();
    x.strokeStyle = 'rgba(20,18,16,0.35)'; x.lineWidth = 1.5; x.stroke();
  }
}

function bulletHoles(x: DCtx, rng: Rng, count: number, cx = S * 0.5, cy = S * 0.42, spread = S * 0.30): void {
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, 6.283), d = Math.sqrt(rng.next()) * spread;
    const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d * 0.8, r = rng.range(1.6, 4.2);
    x.fillStyle = 'rgba(14,13,12,0.85)';
    x.beginPath(); x.arc(px, py, r, 0, 6.283); x.fill();
    x.strokeStyle = 'rgba(230,225,210,0.30)'; x.lineWidth = 1;
    x.beginPath(); x.arc(px, py, r + 1.4, 0, 6.283); x.stroke();
  }
}

function soot(x: DCtx, rng: Rng, count: number): void {
  for (let i = 0; i < count; i++) {
    const cx = rng.range(0, S), cy = rng.range(0, S * 0.8), r = rng.range(10, 34);
    const g = x.createRadialGradient(cx, cy, 1, cx, cy, r);
    g.addColorStop(0, 'rgba(16,15,14,0.55)');
    g.addColorStop(1, 'rgba(16,15,14,0)');
    x.fillStyle = g;
    x.beginPath(); x.ellipse(cx, cy, r * 0.9, r * 1.3, 0, 0, 6.283); x.fill();
  }
}

/** A window with a recessed frame, glass and a sill. */
function window_(x: DCtx, x0: number, y0: number, w: number, h: number, glass: string, frame: string, sill: boolean, broken: number): void {
  x.fillStyle = frame;
  x.fillRect(x0 - 6, y0 - 6, w + 12, h + 12);
  if (broken > 0) {
    x.fillStyle = '#171614';
    x.fillRect(x0, y0, w, h);
    // remaining shards
    // a few large jagged shards still clinging to the frame
    x.fillStyle = 'rgba(168,186,190,0.42)';
    const FX = [0.10, 0.64, 0.36];
    const FY = [0.08, 0.28, 0.70];
    const FW = [0.24, 0.16, 0.19];
    const FH = [0.20, 0.24, 0.14];
    for (let s = 0; s < 3; s++) {
      const sx = x0 + w * FX[s]!, sy = y0 + h * FY[s]!;
      const sw = w * FW[s]!, sh = h * FH[s]!;
      x.beginPath();
      x.moveTo(sx, sy);
      x.lineTo(sx + sw, sy + sh * 0.3);
      x.lineTo(sx + sw * 0.55, sy + sh);
      x.closePath(); x.fill();
    }
    x.fillStyle = 'rgba(12,12,11,0.85)';
    x.beginPath();
    x.moveTo(x0 + w * 0.08, y0 + h * 0.4);
    x.lineTo(x0 + w * 0.55, y0 + h * 0.15);
    x.lineTo(x0 + w * 0.9, y0 + h * 0.6);
    x.lineTo(x0 + w * 0.35, y0 + h * 0.92);
    x.closePath(); x.fill();
  } else {
    const g = x.createLinearGradient(x0, y0, x0 + w * 0.4, y0 + h);
    g.addColorStop(0, glass);
    g.addColorStop(1, 'rgba(0,0,0,0.35)');
    x.fillStyle = g;
    x.fillRect(x0, y0, w, h);
    x.fillStyle = 'rgba(255,255,255,0.10)';
    x.fillRect(x0, y0, w * 0.35, h);
    x.fillStyle = 'rgba(0,0,0,0.30)';
    x.fillRect(x0 + w * 0.48, y0, 3, h);
  }
  if (sill) { x.fillStyle = 'rgba(255,255,255,0.18)'; x.fillRect(x0 - 12, y0 + h + 6, w + 24, 5); }
}

function floorLine(x: DCtx, c: string): void {
  x.fillStyle = c;
  x.fillRect(0, 0, S, 10);
}

function drawWall(x: DCtx, style: number, variant: number, rng: Rng): void {
  x.clearRect(0, 0, S, S);
  const worn = variant >= 1, broken = variant >= 2;
  switch (style) {
    case 0: { // brick
      x.fillStyle = '#9c7a62'; x.fillRect(0, 0, S, S);
      for (let r = 0; r < 32; r++) {
        for (let c = -1; c < 17; c++) {
          const off = r % 2 ? 16 : 0;
          const v = rng.range(-16, 16);
          x.fillStyle = `rgb(${156 + v | 0},${122 + v | 0},${98 + v * 0.8 | 0})`;
          x.fillRect(c * 32 + off + 2, r * 16 + 2, 28, 12);
        }
      }
      floorLine(x, 'rgba(40,30,24,0.55)');
      window_(x, 80, 72, 96, 120, '#5d6a6d', '#6e5545', true, broken ? 0.8 : 0);
      if (worn) { grime(x, rng, 10, 0.16); cracks(x, rng, 4, 'rgba(30,22,18,0.5)', 2); }
      if (broken) { soot(x, rng, 3); spall(x, rng, 4, '#7d5f4b', S * 0.42, S * 0.45, S * 0.22); bulletHoles(x, rng, 14); }
      grain(x, rng, 0.05);
      break;
    }
    case 1: { // concrete
      x.fillStyle = '#adb3ad'; x.fillRect(0, 0, S, S);
      for (let i = 0; i < 18; i++) { x.fillStyle = 'rgba(0,0,0,0.06)'; x.fillRect(0, i * 14 + rng.range(0, 4), S, 2); }
      floorLine(x, 'rgba(60,64,62,0.5)');
      window_(x, 62, 60, 132, 136, '#4f5b60', '#8b918c', false, broken ? 0.7 : 0);
      x.strokeStyle = 'rgba(70,76,74,0.85)'; x.lineWidth = 4;
      x.beginPath(); x.moveTo(32, 208); x.lineTo(224, 208); x.stroke();
      x.lineWidth = 2.5;
      for (let i = 0; i < 13; i++) { x.beginPath(); x.moveTo(36 + i * 15, 208); x.lineTo(36 + i * 15, 236); x.stroke(); }
      x.beginPath(); x.moveTo(32, 236); x.lineTo(224, 236); x.stroke();
      if (worn) { grime(x, rng, 12, 0.15); cracks(x, rng, 5, 'rgba(48,52,50,0.45)', 2); }
      if (broken) { soot(x, rng, 3); spall(x, rng, 5, '#8d938d', S * 0.5, S * 0.45, S * 0.24); bulletHoles(x, rng, 16); }
      grain(x, rng, 0.045);
      break;
    }
    case 2: { // panel
      x.fillStyle = '#b8bbb3'; x.fillRect(0, 0, S, S);
      x.fillStyle = 'rgba(0,0,0,0.10)'; x.fillRect(0, 120, S, 6);
      x.fillStyle = 'rgba(255,255,255,0.10)'; x.fillRect(0, 126, S, 4);
      x.fillStyle = 'rgba(0,0,0,0.16)'; x.fillRect(124, 0, 6, S);
      window_(x, 40, 44, 176, 148, '#57646a', '#8d918b', true, broken ? 0.75 : 0);
      if (worn) { grime(x, rng, 10, 0.14); }
      if (broken) { soot(x, rng, 3); spall(x, rng, 3, '#9b9e97', S * 0.5, S * 0.45, S * 0.2); bulletHoles(x, rng, 12); }
      grain(x, rng, 0.04);
      break;
    }
    case 3: { // glass curtain wall
      const g = x.createLinearGradient(0, 0, 0, S);
      g.addColorStop(0, '#8b9ba1'); g.addColorStop(0.55, '#718086'); g.addColorStop(1, '#5b686f');
      x.fillStyle = g; x.fillRect(0, 0, S, S);
      x.fillStyle = 'rgba(255,255,255,0.07)';
      x.beginPath(); x.moveTo(0, 192); x.lineTo(S, 40); x.lineTo(S, 104); x.lineTo(0, S); x.closePath(); x.fill();
      x.fillStyle = 'rgba(30,36,38,0.85)';
      for (let i = 0; i <= 4; i++) x.fillRect(i * 64 - 4, 0, 8, S);
      x.fillRect(0, 0, S, 10); x.fillRect(0, 244, S, 12);
      x.fillStyle = 'rgba(20,24,26,0.55)'; x.fillRect(0, 122, S, 6);
      if (broken) {
        for (let i = 0; i < 14; i++) {
          const px = S * 0.5 + rng.jitter(S * 0.34), py = S * 0.5 + rng.jitter(S * 0.34);
          x.fillStyle = 'rgba(12,14,15,0.8)';
          x.beginPath(); x.ellipse(px, py, rng.range(8, 26), rng.range(8, 24), rng.range(0, 3), 0, 6.283); x.fill();
        }
      }
      if (worn) grime(x, rng, 8, 0.12);
      if (broken) { soot(x, rng, 3); bulletHoles(x, rng, 10); }
      grain(x, rng, 0.03);
      break;
    }
    case 4: { // corrugated metal
      x.fillStyle = '#9ea4a8'; x.fillRect(0, 0, S, S);
      for (let i = 0; i < 32; i++) {
        x.fillStyle = i % 2 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.10)';
        x.fillRect(i * 16, 0, 8, S);
      }
      floorLine(x, 'rgba(50,54,58,0.6)');
      // vertical panel joints instead of a repeated window, so long sheds do
      // not read as an identical strip of windows
      x.fillStyle = 'rgba(0,0,0,0.16)'; x.fillRect(84, 0, 5, S);
      x.fillStyle = 'rgba(255,255,255,0.06)'; x.fillRect(90, 0, 3, S);
      x.fillStyle = 'rgba(0,0,0,0.10)'; x.fillRect(176, 0, 4, S);
      x.fillStyle = '#4a5459'; x.fillRect(104, 30, 52, 30);
      x.fillStyle = 'rgba(255,255,255,0.10)'; x.fillRect(104, 30, 52, 6);
      x.fillStyle = 'rgba(0,0,0,0.22)'; x.fillRect(0, 216, S, 12);
      if (worn) { grime(x, rng, 14, 0.20); x.fillStyle = 'rgba(96,64,40,0.16)'; for (let i = 0; i < 10; i++) x.fillRect(rng.range(0, S), rng.range(0, S), rng.range(10, 40), rng.range(6, 22)); }
      if (broken) { soot(x, rng, 2); spall(x, rng, 3, '#8b9095', S * 0.5, S * 0.4, S * 0.2); bulletHoles(x, rng, 14); }
      grain(x, rng, 0.05);
      break;
    }
    case 5: { // hospital tile
      x.fillStyle = '#d2d6d2'; x.fillRect(0, 0, S, S);
      for (let i = 0; i < 32; i++) { x.fillStyle = 'rgba(0,0,0,0.05)'; x.fillRect(0, i * 8, S, 1); }
      x.fillStyle = '#9fb3a6'; x.fillRect(0, 0, S, 12);
      window_(x, 44, 68, 68, 124, '#5b6b70', '#9aa5a0', true, broken ? 0.6 : 0);
      window_(x, 144, 68, 68, 124, '#5b6b70', '#9aa5a0', true, broken ? 0.6 : 0);
      if (worn) grime(x, rng, 9, 0.13);
      if (broken) { spall(x, rng, 3, '#b6bbb6', S * 0.5, S * 0.5, S * 0.2); bulletHoles(x, rng, 9); }
      grain(x, rng, 0.035);
      break;
    }
    case 6: { // stone
      x.fillStyle = '#bab4a4'; x.fillRect(0, 0, S, S);
      for (let r = 0; r < 16; r++) {
        for (let c = -1; c < 9; c++) {
          const off = r % 2 ? 32 : 0;
          x.fillStyle = `rgba(0,0,0,${rng.range(0.02, 0.07).toFixed(3)})`;
          x.fillRect(c * 64 + off + 2, r * 16 + 2, 60, 12);
        }
      }
      x.fillStyle = 'rgba(255,255,255,0.10)'; x.fillRect(0, 0, S, 16);
      window_(x, 68, 60, 120, 148, '#4d585c', '#7d7768', true, broken ? 0.65 : 0);
      if (worn) { grime(x, rng, 11, 0.15); cracks(x, rng, 4, 'rgba(60,56,48,0.4)', 2); }
      if (broken) { soot(x, rng, 3); spall(x, rng, 4, '#a49e8e', S * 0.5, S * 0.45, S * 0.22); bulletHoles(x, rng, 12); }
      grain(x, rng, 0.04);
      break;
    }
    default: { // derelict / boarded
      x.fillStyle = '#9d9689'; x.fillRect(0, 0, S, S);
      x.fillStyle = 'rgba(35,30,26,0.30)';
      for (let i = 0; i < 9; i++) x.fillRect(rng.range(0, 200), rng.range(0, 220), rng.range(40, 120), rng.range(16, 52));
      x.fillStyle = '#5f5a4f'; x.fillRect(76, 60, 104, 128);
      x.fillStyle = '#2b2a26'; x.fillRect(84, 68, 88, 112);
      x.fillStyle = '#6e6152'; x.fillRect(80, 112, 96, 18);
      x.fillRect(80, 148, 96, 18);
      grime(x, rng, 14, 0.20);
      cracks(x, rng, 6, 'rgba(30,26,22,0.5)', 2);
      if (broken) { spall(x, rng, 4, '#8b8478', S * 0.5, S * 0.5, S * 0.24); bulletHoles(x, rng, 13); }
      grain(x, rng, 0.09);
      break;
    }
  }
}

function drawGroundBand(x: DCtx, kind: number, rng: Rng): void {
  x.clearRect(0, 0, S, S);
  switch (kind) {
    case 0: { // lobby
      x.fillStyle = '#9ea29c'; x.fillRect(0, 0, S, S);
      x.fillStyle = '#3f4a4e'; x.fillRect(28, 52, 200, 192);
      x.fillStyle = 'rgba(190,205,205,0.16)'; x.fillRect(28, 52, 200, 44);
      x.fillStyle = 'rgba(20,24,25,0.85)'; x.fillRect(120, 60, 12, 184);
      x.fillRect(24, 40, 208, 14);
      x.fillStyle = 'rgba(255,255,255,0.12)'; x.fillRect(0, 0, S, 8);
      break;
    }
    case 1: { // shopfront
      x.fillStyle = '#8f948f'; x.fillRect(0, 0, S, S);
      x.fillStyle = '#39424a'; x.fillRect(16, 80, 224, 164);
      x.fillStyle = 'rgba(200,215,215,0.14)'; x.fillRect(16, 80, 224, 52);
      x.fillStyle = 'rgba(15,18,20,0.85)';
      x.fillRect(20, 80, 10, 164); x.fillRect(226, 80, 10, 164); x.fillRect(124, 88, 10, 156);
      x.fillStyle = '#8b7a52'; x.fillRect(0, 24, S, 40);
      x.fillStyle = 'rgba(255,255,255,0.20)'; x.fillRect(0, 24, S, 8);
      x.fillStyle = 'rgba(0,0,0,0.28)'; x.fillRect(0, 64, S, 6);
      break;
    }
    case 2: { // loading shutter
      x.fillStyle = '#7d817c'; x.fillRect(0, 0, S, S);
      x.fillStyle = '#5c605c'; x.fillRect(12, 12, 232, 236);
      for (let i = 0; i < 58; i++) {
        x.fillStyle = i % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
        x.fillRect(12, 12 + i * 4, 232, 2);
      }
      x.fillStyle = '#3a3d3a'; x.fillRect(12, 236, 232, 16);
      x.fillStyle = 'rgba(230,200,90,0.20)'; x.fillRect(104, 80, 48, 92);
      break;
    }
    case 3: { // clinic
      x.fillStyle = '#c9cfca'; x.fillRect(0, 0, S, S);
      x.fillStyle = '#454f53'; x.fillRect(32, 60, 192, 184);
      x.fillStyle = 'rgba(210,225,225,0.18)'; x.fillRect(32, 60, 192, 56);
      x.fillStyle = 'rgba(20,24,25,0.85)'; x.fillRect(40, 68, 10, 176); x.fillRect(206, 68, 10, 176);
      x.fillStyle = '#c8564f';
      x.fillRect(116, 16, 24, 68); x.fillRect(94, 38, 68, 24);
      break;
    }
    default: { // shutter boards
      x.fillStyle = '#948f86'; x.fillRect(0, 0, S, S);
      x.fillStyle = '#5d5a52'; x.fillRect(20, 36, 216, 208);
      for (let i = 0; i < 52; i++) {
        x.fillStyle = i % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.14)';
        x.fillRect(20, 36 + i * 4, 216, 2);
      }
      x.fillStyle = 'rgba(60,35,25,0.35)'; x.fillRect(28, 192, 80, 44);
      break;
    }
  }
  grain(x, rng, 0.05);
}

function drawRoof(x: DCtx, kind: number, rng: Rng): void {
  x.clearRect(0, 0, S, S);
  if (kind === 0) { // gravel
    x.fillStyle = '#8a8c84'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 2600; i++) {
      const v = rng.range(-24, 24);
      x.fillStyle = v > 0 ? `rgba(255,255,255,${(v / 255).toFixed(3)})` : `rgba(0,0,0,${(-v / 255).toFixed(3)})`;
      x.fillRect(rng.range(0, S - 1), rng.range(0, S - 1), 2, 2);
    }
    // purely fine-grained: any larger motif would repeat visibly on a big roof
    for (let i = 0; i < 9000; i++) {
      const v = rng.range(-0.06, 0.06);
      x.fillStyle = v > 0 ? `rgba(255,255,255,${v.toFixed(3)})` : `rgba(0,0,0,${(-v).toFixed(3)})`;
      x.fillRect(rng.range(0, S - 1), rng.range(0, S - 1), 2, 2);
    }
  } else if (kind === 1) { // tar
    x.fillStyle = '#6a6c66'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 7; i++) {
      x.fillStyle = `rgba(0,0,0,${rng.range(0.02, 0.045).toFixed(3)})`;
      x.beginPath(); x.ellipse(rng.range(0, S), rng.range(0, S), rng.range(30, 90), rng.range(22, 62), rng.range(0, 3), 0, 6.283); x.fill();
    }
    for (let i = 0; i < 1400; i++) {
      x.fillStyle = rng.chance(0.5) ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.08)';
      x.fillRect(rng.range(0, S - 1), rng.range(0, S - 1), 3, 3);
    }
  } else { // metal
    x.fillStyle = '#8f959a'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 16; i++) {
      x.fillStyle = 'rgba(0,0,0,0.05)'; x.fillRect(0, i * 16, S, 3);
      x.fillStyle = 'rgba(255,255,255,0.04)'; x.fillRect(0, i * 16 + 3, S, 3);
    }
    for (let i = 0; i < 900; i++) {
      const v = rng.range(-0.05, 0.05);
      x.fillStyle = v > 0 ? `rgba(255,255,255,${v.toFixed(3)})` : `rgba(160,110,70,${(-v * 1.4).toFixed(3)})`;
      x.fillRect(rng.range(0, S - 1), rng.range(0, S - 1), rng.range(5, 18), rng.range(4, 12));
    }
  }
}

export function buildFacadeCanvases(): HTMLCanvasElement[] {
  const canvases: HTMLCanvasElement[] = [];
  const rng = new Rng(0x9e3779b1);
  for (let variant = 0; variant < 3; variant++) {
    for (let style = 0; style < 8; style++) {
      const { c, x } = tile();
      drawWall(x, style, variant, rng);
      canvases[wallLayer(style, variant)] = c;
    }
  }
  for (let g = 0; g < 5; g++) { const { c, x } = tile(); drawGroundBand(x, g, rng); canvases[24 + g] = c; }
  for (let r = 0; r < 3; r++) { const { c, x } = tile(); drawRoof(x, r, rng); canvases[29 + r] = c; }
  return canvases;
}

export function buildFacadeTexture(gl: GL): WebGLTexture {
  const canvases: HTMLCanvasElement[] = [];
  const rng = new Rng(0x9e3779b1);
  for (let variant = 0; variant < 3; variant++) {
    for (let style = 0; style < 8; style++) {
      const { c, x } = tile();
      drawWall(x, style, variant, rng);
      canvases[wallLayer(style, variant)] = c;
    }
  }
  for (let g = 0; g < 5; g++) {
    const { c, x } = tile();
    drawGroundBand(x, g, rng);
    canvases[24 + g] = c;
  }
  for (let r = 0; r < 3; r++) {
    const { c, x } = tile();
    drawRoof(x, r, rng);
    canvases[29 + r] = c;
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, S, S, FACADE_LAYERS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (let i = 0; i < FACADE_LAYERS; i++) {
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, S, S, 1, gl.RGBA, gl.UNSIGNED_BYTE, canvases[i]!);
  }
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  return tex;
}

/** Small tiling surface-detail texture, multiplied over the baked ground map so
 *  pavement keeps reading at close zoom where the 0.48 px/unit bake blurs. */
export function buildDetailTexture(gl: GL): WebGLTexture {
  const T = 256;
  const c = document.createElement('canvas');
  c.width = T; c.height = T;
  const x = c.getContext('2d')!;
  const img = x.createImageData(T, T);
  const rng = new Rng(0x51a7c0de);
  const grid = 32;
  const g = new Float32Array(grid * grid);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  const sample = (u: number, v: number): number => {
    const gu = u * grid, gv = v * grid;
    const u0 = Math.floor(gu), v0 = Math.floor(gv);
    const fu = gu - u0, fv = gv - v0;
    const a = g[((v0 % grid) + grid) % grid * grid + (((u0 % grid) + grid) % grid)]!;
    const b = g[((v0 % grid) + grid) % grid * grid + (((u0 + 1) % grid) + grid) % grid]!;
    const cc = g[(((v0 + 1) % grid) + grid) % grid * grid + (((u0 % grid) + grid) % grid)]!;
    const d = g[(((v0 + 1) % grid) + grid) % grid * grid + (((u0 + 1) % grid) + grid) % grid]!;
    const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
    return lerp(lerp(a, b, su), lerp(cc, d, su), sv);
  };
  for (let y = 0; y < T; y++) {
    for (let xx = 0; xx < T; xx++) {
      const u = xx / T, v = y / T;
      let n = sample(u, v) * 0.55 + sample(u * 4, v * 4) * 0.28 + sample(u * 16, v * 16) * 0.17;
      n = clamp(n * 1.35 - 0.18, 0, 1);
      const o = (y * T + xx) * 4;
      const val = Math.round(n * 255);
      img.data[o] = val; img.data[o + 1] = val; img.data[o + 2] = val; img.data[o + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

// ------------------------------------------------------------------ ground

export const GROUND_TEX_W = 4096;
export const GROUND_TEX_H = 3072;

const ROAD_COLORS: Record<string, string> = {
  avenue: '#3a3b36', street: '#37382f', alley: '#343530', rail: '#3d3e39', path: '#5e5e52',
};

export function bakeGround(city: City): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = GROUND_TEX_W; c.height = GROUND_TEX_H;
  const x = c.getContext('2d')!;
  const sc = GROUND_TEX_W / WORLD_W;
  const rng = new Rng(0x1f2e3d4c);
  x.fillStyle = '#54554b';
  x.fillRect(0, 0, GROUND_TEX_W, GROUND_TEX_H);

  for (let i = 0; i < 620; i++) {
    const r = rng.range(70, 460);
    x.fillStyle = rng.chance(0.5)
      ? `rgba(255,255,255,${rng.range(0.008, 0.028).toFixed(3)})`
      : `rgba(0,0,0,${rng.range(0.01, 0.05).toFixed(3)})`;
    x.beginPath();
    x.ellipse(rng.range(0, GROUND_TEX_W), rng.range(0, GROUND_TEX_H), r, r * rng.range(0.5, 1), rng.range(0, 3), 0, 6.283);
    x.fill();
  }

  for (const d of city.districts) {
    x.fillStyle = d.ground;
    x.globalAlpha = 0.88;
    x.beginPath();
    x.ellipse((d.x + d.w / 2) * sc, (d.y + d.h / 2) * sc, d.w * 0.5 * sc, d.h * 0.5 * sc, 0, 0, 6.283);
    x.fill();
    x.globalAlpha = 1;
    if (d.kind === 'park') {
      for (let i = 0; i < 1400; i++) {
        const px = rng.range(d.x, d.x + d.w) * sc, py = rng.range(d.y, d.y + d.h) * sc;
        x.fillStyle = rng.chance(0.5) ? 'rgba(110,138,80,0.30)' : 'rgba(26,36,20,0.28)';
        x.beginPath(); x.ellipse(px, py, rng.range(10, 62), rng.range(8, 40), rng.range(0, 3), 0, 6.283); x.fill();
      }
      // mown stripes give the grass scale
      x.save();
      x.beginPath(); x.rect(d.x * sc, d.y * sc, d.w * sc, d.h * sc); x.clip();
      x.globalAlpha = 0.06;
      for (let i = -20; i < 90; i++) {
        x.fillStyle = i % 2 ? '#ffffff' : '#000000';
        x.save();
        x.translate(d.x * sc, d.y * sc);
        x.rotate(0.6);
        x.fillRect(i * 40, -1600, 22, 4200);
        x.restore();
      }
      x.restore();
    }
    if (d.kind === 'industrial' || d.kind === 'storage') {
      x.fillStyle = 'rgba(0,0,0,0.14)';
      for (let i = 0; i < 40; i++) {
        x.fillRect(rng.range(d.x, d.x + d.w) * sc, rng.range(d.y, d.y + d.h) * sc, rng.range(26, 120), rng.range(18, 80));
      }
    }
  }

  const civic = city.districts.find(d => d.kind === 'civic');
  if (civic) {
    x.fillStyle = '#8c8574';
    x.beginPath();
    x.ellipse((civic.x + civic.w * 0.5) * sc, (civic.y + civic.h * 0.66) * sc, civic.w * 0.34 * sc, civic.h * 0.24 * sc, 0, 0, 6.283);
    x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.05)'; x.lineWidth = 2;
    for (let i = 1; i < 6; i++) {
      x.beginPath();
      x.ellipse((civic.x + civic.w * 0.5) * sc, (civic.y + civic.h * 0.66) * sc, civic.w * 0.34 * sc * (i / 6), civic.h * 0.24 * sc * (i / 6), 0, 0, 6.283);
      x.stroke();
    }
  }

  for (const b of city.blocks) {
    const t = rng.next();
    if (b.park) continue;
    x.fillStyle = t > 0.5 ? `rgba(255,255,255,${(0.02 + t * 0.05).toFixed(3)})` : `rgba(0,0,0,${(0.02 + t * 0.05).toFixed(3)})`;
    x.fillRect(b.x * sc, b.y * sc, b.w * sc, b.h * sc);
  }
  for (const b of city.blocks) {
    if (b.park) continue;
    x.strokeStyle = 'rgba(24,25,22,0.34)';
    x.lineWidth = Math.max(1, 2.2 * sc);
    x.strokeRect(b.x * sc, b.y * sc, b.w * sc, b.h * sc);
  }

  x.lineCap = 'butt'; x.lineJoin = 'round';
  for (const r of city.roads) {
    if (r.kind === 'rail' || r.kind === 'path') continue;
    const pts: number[] = [];
    for (let i = 0; i < r.pts.length; i += 2) { pts.push(r.pts[i]! * sc, r.pts[i + 1]! * sc); }
    const path = () => { x.beginPath(); x.moveTo(pts[0]!, pts[1]!); for (let i = 2; i < pts.length; i += 2) x.lineTo(pts[i]!, pts[i + 1]!); };
    x.strokeStyle = 'rgba(16,17,15,0.30)'; x.lineWidth = (r.width + 24) * sc; path(); x.stroke();
    x.strokeStyle = '#85867b'; x.lineWidth = (r.width + 13) * sc; path(); x.stroke();
    x.strokeStyle = ROAD_COLORS[r.kind] ?? '#3a3b36'; x.lineWidth = r.width * sc; path(); x.stroke();
    if (r.kind === 'avenue') {
      x.strokeStyle = 'rgba(210,207,186,0.16)';
      x.lineWidth = Math.max(1, 1.3 * sc);
      x.setLineDash([26 * sc, 30 * sc]);
      path(); x.stroke();
      x.setLineDash([]);
    }
  }
  for (const r of city.roads) {
    if (r.kind !== 'path') continue;
    const pts: number[] = [];
    for (let i = 0; i < r.pts.length; i += 2) { pts.push(r.pts[i]! * sc, r.pts[i + 1]! * sc); }
    x.beginPath(); x.moveTo(pts[0]!, pts[1]!); for (let i = 2; i < pts.length; i += 2) x.lineTo(pts[i]!, pts[i + 1]!);
    x.strokeStyle = '#5c5b4a'; x.lineWidth = 26 * sc; x.stroke();
    x.strokeStyle = '#6f6d58'; x.lineWidth = 16 * sc; x.stroke();
  }
  for (const r of city.roads) {
    if (r.kind !== 'rail') continue;
    const pts: number[] = [];
    for (let i = 0; i < r.pts.length; i += 2) { pts.push(r.pts[i]! * sc, r.pts[i + 1]! * sc); }
    x.beginPath(); x.moveTo(pts[0]!, pts[1]!); for (let i = 2; i < pts.length; i += 2) x.lineTo(pts[i]!, pts[i + 1]!);
    x.strokeStyle = 'rgba(0,0,0,0.30)'; x.lineWidth = 74 * sc; x.stroke();
    x.strokeStyle = '#3a3a34'; x.lineWidth = 52 * sc; x.stroke();
  }

  // scorch + rubble staining around damaged buildings
  for (const b of city.buildings) {
    if (b.damage < 0.35) continue;
    const n = Math.round(b.damage * 5);
    for (let i = 0; i < n; i++) {
      const px = (b.cx + rng.jitter(b.w * 0.9)) * sc;
      const py = (b.cy + rng.jitter(b.d * 0.9)) * sc;
      const r = rng.range(8, 26) * sc * 4;
      const g = x.createRadialGradient(px, py, 1, px, py, r);
      g.addColorStop(0, 'rgba(14,13,11,0.5)');
      g.addColorStop(1, 'rgba(14,13,11,0)');
      x.fillStyle = g;
      x.beginPath(); x.ellipse(px, py, r, r * 0.7, 0, 0, 6.283); x.fill();
    }
  }

  // objective ground markings: painted zone rings, so the marker belongs to
  // the ground instead of floating over the rooftops
  for (const o of city.objectives) {
    const cx = o.x * sc, cy = o.y * sc, rr = o.r * sc;
    x.save();
    x.beginPath(); x.ellipse(cx, cy, rr, rr * 0.98, 0, 0, 6.283);
    x.fillStyle = 'rgba(226,222,206,0.10)'; x.fill();
    x.lineWidth = Math.max(2, 4.5 * sc); x.strokeStyle = 'rgba(20,21,18,0.45)';
    x.setLineDash([16 * sc, 12 * sc]); x.stroke();
    x.lineWidth = Math.max(1.4, 3 * sc); x.strokeStyle = 'rgba(232,228,212,0.55)'; x.stroke();
    x.setLineDash([]);
    x.lineWidth = Math.max(1, 2.4 * sc); x.strokeStyle = 'rgba(232,228,212,0.60)';
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      x.beginPath();
      x.moveTo(cx + Math.cos(a) * rr * 0.62, cy + Math.sin(a) * rr * 0.62);
      x.lineTo(cx + Math.cos(a) * rr * 0.96, cy + Math.sin(a) * rr * 0.96);
      x.stroke();
    }
    x.beginPath(); x.ellipse(cx, cy, rr * 0.30, rr * 0.30, 0, 0, 6.283);
    x.lineWidth = Math.max(1.4, 3 * sc); x.strokeStyle = 'rgba(232,228,212,0.55)'; x.stroke();
    x.restore();
  }

  const sunX = 0.52, sunY = 0.86;
  for (const b of city.buildings) {
    const len = b.height * 0.62;
    const ox = sunX * len, oy = sunY * len;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 4; i++) {
      pts.push([b.corners[i * 2]!, b.corners[i * 2 + 1]!]);
      pts.push([b.corners[i * 2]! + ox, b.corners[i * 2 + 1]! + oy]);
    }
    const hull = convexHull(pts);
    x.beginPath();
    x.moveTo(hull[0]![0] * sc, hull[0]![1] * sc);
    for (let i = 1; i < hull.length; i++) x.lineTo(hull[i]![0] * sc, hull[i]![1] * sc);
    x.closePath();
    x.fillStyle = 'rgba(10,12,10,0.26)';
    x.fill();
    x.beginPath();
    x.moveTo(b.corners[0]! * sc, b.corners[1]! * sc);
    for (let i = 1; i < 4; i++) x.lineTo(b.corners[i * 2]! * sc, b.corners[i * 2 + 1]! * sc);
    x.closePath();
    x.fillStyle = 'rgba(14,15,13,0.50)';
    x.fill();
    x.strokeStyle = 'rgba(0,0,0,0.50)';
    x.lineWidth = Math.max(1, 3 * sc);
    x.stroke();
    // soft ambient occlusion skirt so buildings sit on the ground
    const ao = x.createRadialGradient(b.cx * sc, b.cy * sc, Math.max(b.w, b.d) * 0.28 * sc, b.cx * sc, b.cy * sc, Math.max(b.w, b.d) * 0.95 * sc);
    ao.addColorStop(0, 'rgba(10,11,10,0.42)');
    ao.addColorStop(1, 'rgba(10,11,10,0)');
    x.fillStyle = ao;
    x.beginPath(); x.ellipse(b.cx * sc, b.cy * sc, Math.max(b.w, b.d) * 0.95 * sc, Math.max(b.w, b.d) * 0.95 * sc * 0.85, 0, 0, 6.283); x.fill();
  }

  for (const b of city.blocks) {
    if (b.park) continue;
    const step = 26 * sc;
    x.strokeStyle = 'rgba(20,21,18,0.10)';
    x.lineWidth = 1;
    x.beginPath();
    for (let gx = b.x * sc; gx < (b.x + b.w) * sc; gx += step) { x.moveTo(gx, b.y * sc); x.lineTo(gx, (b.y + b.h) * sc); }
    for (let gy = b.y * sc; gy < (b.y + b.h) * sc; gy += step) { x.moveTo(b.x * sc, gy); x.lineTo((b.x + b.w) * sc, gy); }
    x.stroke();
  }
  for (let i = 0; i < 1400; i++) {
    const px = rng.range(0, GROUND_TEX_W), py = rng.range(0, GROUND_TEX_H);
    x.fillStyle = rng.chance(0.5) ? 'rgba(60,52,38,0.10)' : 'rgba(20,22,19,0.12)';
    x.beginPath();
    x.ellipse(px, py, rng.range(8, 70), rng.range(6, 46), rng.range(0, 3), 0, 6.283);
    x.fill();
  }
  for (let i = 0; i < 120000; i++) {
    const v = rng.range(-0.10, 0.10);
    x.fillStyle = v > 0 ? `rgba(255,255,255,${v.toFixed(3)})` : `rgba(0,0,0,${(-v).toFixed(3)})`;
    x.fillRect(rng.range(0, GROUND_TEX_W), rng.range(0, GROUND_TEX_H), 2, 2);
  }
  return c;
}

function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
