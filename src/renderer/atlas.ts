// Sprite atlases, generated procedurally at boot.
//
//   unit atlas:  7 figure types x 5 authored directions x 24 frames, 96px cells
//   prop atlas:  trees / barricades / wrecks / corpses, 384px cells
//
// Both share one pixel scale (PX_PER_SWU) so world-space sizing stays uniform.

import { TAU } from '../core/math';
import { ZSCALE, HUMAN_HEIGHT } from '../core/config';
import { ALL_TYPES } from '../entities/types';
import {
  ANIM_ORDER, ANIM_FRAMES, ANIM_OFFSET, DIR_BASE, DIR_BASE_ANGLE, TOTAL_FRAMES,
  type AnimName,
} from '../entities/anim';
import { CELL, FEET_ROW, CHAR_H, FIGURE_SPECS, renderFigure, renderCorpse, type FigureSpec } from './figures';

export const PX_PER_SWU = CHAR_H / (HUMAN_HEIGHT * ZSCALE);

export const UNIT_CELL = CELL;
export const UNIT_COLS = 32;
export const UNIT_ROWS = 32;
export const UNIT_ATLAS = UNIT_CELL * UNIT_COLS; // 3072

export const PROP_CELL = 384;
export const PROP_COLS = 5;
export const PROP_ROWS = 5;
export const PROP_ATLAS = PROP_CELL * PROP_COLS; // 1920
export const PROP_ANCHOR_X = PROP_CELL * 0.5;
export const PROP_ANCHOR_Y = PROP_CELL * 0.917;
export const PROP_WORLD_SIZE = PROP_CELL / PX_PER_SWU;

export interface AtlasLayout {
  unitCanvas: HTMLCanvasElement;
  propCanvas: HTMLCanvasElement;
  /** [typeIndex][dirBase][frameIndex] -> muzzle offset in cell px */
  muzzle: Float32Array;
  propIndex: Record<string, number>;
}

export function unitCellIndex(typeIndex: number, dirBase: number, frameIndex: number): number {
  return (typeIndex * DIR_BASE + dirBase) * TOTAL_FRAMES + frameIndex;
}

function allocCanvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: true })!;
  ctx.imageSmoothingEnabled = true;
  return { c, ctx };
}

export function buildAtlases(onProgress?: (p: number) => void): AtlasLayout {
  const { c: unitCanvas, ctx: uctx } = allocCanvas(UNIT_ATLAS, UNIT_ATLAS);
  const { c: propCanvas, ctx: pctx } = allocCanvas(PROP_ATLAS, PROP_ATLAS);
  uctx.clearRect(0, 0, UNIT_ATLAS, UNIT_ATLAS);
  pctx.clearRect(0, 0, PROP_ATLAS, PROP_ATLAS);
  const muzzle = new Float32Array(ALL_TYPES.length * DIR_BASE * TOTAL_FRAMES * 2);

  let done = 0;
  const totalCells = ALL_TYPES.length * DIR_BASE * TOTAL_FRAMES;
  for (let t = 0; t < ALL_TYPES.length; t++) {
    const spec = FIGURE_SPECS[ALL_TYPES[t]!]!;
    for (let d = 0; d < DIR_BASE; d++) {
      const angle = DIR_BASE_ANGLE[d]!;
      for (const anim of ANIM_ORDER) {
        const n = ANIM_FRAMES[anim];
        for (let f = 0; f < n; f++) {
          const frameIndex = ANIM_OFFSET[anim] + f;
          const cell = unitCellIndex(t, d, frameIndex);
          const cx = (cell % UNIT_COLS) * UNIT_CELL;
          const cy = ((cell / UNIT_COLS) | 0) * UNIT_CELL;
          const phase = (f + 0.5) / n;
          const res = renderFigure(uctx, spec, anim, f, phase, angle, cx + UNIT_CELL / 2, cy + FEET_ROW);
          const mi = ((t * DIR_BASE + d) * TOTAL_FRAMES + frameIndex) * 2;
          // renderFigure translates the context to (cx + UNIT_CELL/2, cy + FEET_ROW)
          // itself, so its muzzle point is already expressed relative to that
          // anchor — store it as-is rather than subtracting the cell origin twice.
          muzzle[mi] = res.muzzle.x;
          muzzle[mi + 1] = res.muzzle.y;
        }
      }
    }
    done += DIR_BASE * TOTAL_FRAMES;
    onProgress?.(done / totalCells);
  }

  const propIndex = buildProps(pctx);
  return { unitCanvas, propCanvas, muzzle, propIndex };
}

// --------------------------------------------------------------------- props

interface PropDef { name: string; draw: (ctx: CanvasRenderingContext2D, frame: number) => void }

const S = PX_PER_SWU; // pixels per screen-world-unit

function shadow(ctx: CanvasRenderingContext2D, w: number, h: number, ox = 6, oy = 4): void {
  ctx.beginPath();
  ctx.ellipse(ox, oy, w, h, 0, 0, TAU);
  ctx.fillStyle = 'rgba(9,11,9,0.30)';
  ctx.fill();
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c1: string, c2: string): void {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.86, 0, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(12,16,11,0.55)';
  ctx.stroke();
}

const PROPS: PropDef[] = [
  { name: 'tree_a', draw: (ctx, f) => {
    const sway = Math.sin((f / 4) * TAU) * 3.2;
    const p = (u: number, v: number): [number, number] => [u * S + sway * (v / 34), -v * S * ZSCALE];
    ctx.save();
    shadow(ctx, 12 * S * 0.55, 6 * S * 0.5, 10, 2);
    // trunk
    const [tx, ty] = p(0, 0);
    ctx.beginPath();
    ctx.moveTo(tx - 0.55 * S, ty + 4);
    ctx.lineTo(tx + 0.55 * S, ty + 4);
    ctx.lineTo(tx + 0.35 * S + sway * 0.4, ty - 5.2 * S * ZSCALE);
    ctx.lineTo(tx - 0.42 * S + sway * 0.4, ty - 5.2 * S * ZSCALE);
    ctx.closePath();
    ctx.fillStyle = '#3a3128';
    ctx.fill();
    // canopy
    const cy1 = ty - 9.4 * S * ZSCALE;
    blob(ctx, tx + sway * 0.7, cy1, 4.6 * S * 0.52, '#5d6b45', '#38412b');
    blob(ctx, tx - 3.1 * S * 0.5 + sway * 0.55, cy1 + 1.5 * S * ZSCALE, 3.5 * S * 0.52, '#6a7850', '#3d472e');
    blob(ctx, tx + 3.2 * S * 0.5 + sway * 0.9, cy1 + 1.1 * S * ZSCALE, 3.6 * S * 0.52, '#556340', '#333c27');
    blob(ctx, tx + sway * 1.2, cy1 - 2.0 * S * ZSCALE, 3.2 * S * 0.52, '#77855a', '#495433');
    blob(ctx, tx - 1.4 * S * 0.6 + sway * 0.8, cy1 - 2.6 * S * ZSCALE, 2.6 * S * 0.52, '#879468', '#525d3a');
    ctx.restore();
  } },
  { name: 'tree_b', draw: (ctx, f) => {
    const sway = Math.sin((f / 4) * TAU + 1.1) * 2.4;
    ctx.save();
    shadow(ctx, 7 * S * 0.55, 4 * S * 0.5, 6, 2);
    ctx.fillStyle = '#3a3128';
    ctx.fillRect(-0.5 * S, -1.4 * S * ZSCALE, 1.0 * S, -1.8 * S * ZSCALE);
    for (let i = 0; i < 4; i++) {
      const y = -2.2 * S * ZSCALE - i * 2.6 * S * ZSCALE;
      const w = (4.6 - i * 0.9) * S * 0.5;
      const sh = (i * 0.5 + sway * (i + 1) / 5);
      ctx.beginPath();
      ctx.moveTo(-w + sh, y);
      ctx.lineTo(w + sh, y);
      ctx.lineTo(sh + sway * 1.2, y - 3.6 * S * ZSCALE);
      ctx.closePath();
      ctx.fillStyle = ['#39452c', '#41502f', '#485934', '#516337'][i]!;
      ctx.fill();
      ctx.strokeStyle = 'rgba(12,16,11,0.5)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
  } },
  { name: 'bush', draw: (ctx, f) => {
    const sway = Math.sin((f / 2) * TAU) * 1.5;
    ctx.save();
    shadow(ctx, 3.4 * S * 0.5, 2 * S * 0.5, 3, 1);
    blob(ctx, sway, -1.5 * S * ZSCALE, 2.0 * S * 0.5, '#5c6a44', '#333c26');
    blob(ctx, -1.5 * S * 0.5, -1.0 * S * ZSCALE, 1.5 * S * 0.5, '#66744b', '#3a442c');
    blob(ctx, 1.6 * S * 0.5 + sway, -1.1 * S * ZSCALE, 1.4 * S * 0.5, '#556340', '#2f3823');
    ctx.restore();
  } },
  { name: 'barricade_a', draw: (ctx) => {
    ctx.save();
    shadow(ctx, 7.5 * S * 0.5, 3.4 * S * 0.5, 5, 1);
    for (let i = 0; i < 6; i++) {
      const x = (-2.5 + i) * 1.35 * S;
      const y = -0.55 * S * ZSCALE + Math.sin(i * 1.7) * 2;
      ctx.beginPath();
      ctx.ellipse(x, y, 0.78 * S, 0.46 * S, 0.06, 0, TAU);
      const g = ctx.createLinearGradient(x - 20, y - 14, x + 16, y + 12);
      g.addColorStop(0, '#7d7355');
      g.addColorStop(1, '#4b452f');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = 'rgba(14,15,10,0.6)';
      ctx.stroke();
    }
    ctx.restore();
  } },
  { name: 'barricade_b', draw: (ctx) => {
    ctx.save();
    shadow(ctx, 6 * S * 0.5, 4.5 * S * 0.5, 5, 1);
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 3; i++) {
        const x = (-1 + i) * 1.35 * S + (r % 2) * 0.6 * S;
        const y = -0.5 * S * ZSCALE - r * 0.85 * S;
        ctx.beginPath();
        ctx.ellipse(x, y, 0.78 * S, 0.46 * S, 0, 0, TAU);
        const g = ctx.createLinearGradient(x - 20, y - 14, x + 16, y + 12);
        g.addColorStop(0, '#6f6849');
        g.addColorStop(1, '#413c29');
        ctx.fillStyle = g;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = 'rgba(14,15,10,0.6)';
        ctx.stroke();
      }
    }
    ctx.restore();
  } },
  { name: 'wire', draw: (ctx) => {
    ctx.save();
    shadow(ctx, 6 * S * 0.5, 2.4 * S * 0.5, 4, 1);
    ctx.strokeStyle = '#3d3f3c';
    ctx.lineWidth = 2.2;
    for (const px of [-5.4 * S / 2, 5.4 * S / 2]) {
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, -2.6 * S * ZSCALE); ctx.stroke();
    }
    ctx.strokeStyle = '#6a6d69';
    ctx.lineWidth = 1.5;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      for (let x = -5.4 * S / 2; x <= 5.4 * S / 2; x += 4) {
        const y = -0.4 * S - k * 0.8 * S + Math.sin(x * 0.35) * 3;
        if (x === -5.4 * S / 2) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  } },
  { name: 'wreck', draw: (ctx) => {
    ctx.save();
    shadow(ctx, 7.4 * S * 0.5, 3.6 * S * 0.5, 6, 2);
    ctx.translate(0, -0.7 * S * ZSCALE);
    ctx.beginPath();
    ctx.moveTo(-3.4 * S, -1.1 * S);
    ctx.lineTo(3.2 * S, -1.4 * S);
    ctx.lineTo(3.7 * S, 1.0 * S);
    ctx.lineTo(-3.5 * S, 1.2 * S);
    ctx.closePath();
    ctx.fillStyle = '#33322e';
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,10,9,0.8)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-1.5 * S, -1.25 * S);
    ctx.lineTo(0.9 * S, -1.35 * S);
    ctx.lineTo(1.0 * S, 0.5 * S);
    ctx.lineTo(-1.4 * S, 0.55 * S);
    ctx.closePath();
    ctx.fillStyle = '#4a4c47';
    ctx.fill();
    ctx.fillStyle = '#1c1d1b';
    ctx.fillRect(-1.2 * S, -1.05 * S, 0.8 * S, 0.5 * S);
    ctx.restore();
  } },
  { name: 'barrel', draw: (ctx) => {
    ctx.save();
    shadow(ctx, 0.75 * S, 0.42 * S, 3, 1);
    const g = ctx.createLinearGradient(-14, 0, 14, 0);
    g.addColorStop(0, '#4a4f48'); g.addColorStop(0.5, '#6a7064'); g.addColorStop(1, '#3c403a');
    ctx.beginPath();
    ctx.ellipse(0, -0.95 * S * ZSCALE, 0.62 * S, 0.4 * S, 0, 0, TAU);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(12,13,11,0.7)'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.restore();
  } },
  { name: 'lamp', draw: (ctx) => {
    ctx.save();
    shadow(ctx, 1.4 * S * 0.5, 0.9 * S * 0.5, 5, 2);
    ctx.strokeStyle = '#3f423f'; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -8.2 * S * ZSCALE); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -8.2 * S * ZSCALE); ctx.lineTo(1.5 * S, -8.6 * S * ZSCALE); ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(1.7 * S, -8.5 * S * ZSCALE, 0.7 * S, 0.28 * S, 0, 0, TAU);
    ctx.fillStyle = '#5d605c'; ctx.fill();
    ctx.restore();
  } },
  { name: 'rubble', draw: (ctx) => {
    ctx.save();
    shadow(ctx, 3.2 * S * 0.5, 2.2 * S * 0.5, 3, 1);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU * 1.7;
      const r = (i % 4) * 0.42 * S;
      const x = Math.cos(a) * r, y = -0.25 * S * ZSCALE + Math.sin(a) * r * 0.42;
      const w = 0.30 * S + (i % 3) * 0.12 * S;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = ['#54544c', '#45453f', '#5f5f56'][i % 3]!;
      ctx.fillRect(-w / 2, -w / 2.6, w, w / 1.3);
      ctx.strokeStyle = 'rgba(12,12,10,0.5)'; ctx.lineWidth = 1.2;
      ctx.strokeRect(-w / 2, -w / 2.6, w, w / 1.3);
      ctx.restore();
    }
    ctx.restore();
  } },
  { name: 'crate', draw: (ctx) => {
    ctx.save();
    shadow(ctx, 1.2 * S * 0.5, 0.8 * S * 0.5, 3, 1);
    ctx.fillStyle = '#5a4c38';
    ctx.beginPath();
    ctx.moveTo(-1.0 * S, -0.4 * S);
    ctx.lineTo(1.0 * S, -0.4 * S);
    ctx.lineTo(1.0 * S, -1.9 * S * ZSCALE);
    ctx.lineTo(-1.0 * S, -1.9 * S * ZSCALE);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(14,12,9,0.7)'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-1.0 * S, -0.4 * S); ctx.lineTo(1.0 * S, -1.9 * S * ZSCALE);
    ctx.moveTo(1.0 * S, -0.4 * S); ctx.lineTo(-1.0 * S, -1.9 * S * ZSCALE);
    ctx.strokeStyle = 'rgba(14,12,9,0.45)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
  } },
  { name: 'blood_a', draw: (ctx) => splat(ctx, 0) },
  { name: 'blood_b', draw: (ctx) => splat(ctx, 1) },
  { name: 'blood_c', draw: (ctx) => splat(ctx, 2) },
  { name: 'crater', draw: (ctx) => {
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 0, 2.6 * S, 1.5 * S, 0, 0, TAU);
    ctx.fillStyle = 'rgba(24,23,20,0.5)'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, 0, 1.7 * S, 0.95 * S, 0, 0, TAU);
    ctx.fillStyle = 'rgba(14,13,11,0.6)'; ctx.fill();
    ctx.restore();
  } },
  { name: 'corpse_h_a', draw: (ctx) => renderCorpse(ctx, FIGURE_SPECS.rifleman!, 0, PROP_ANCHOR_X, PROP_ANCHOR_Y, 0.4) },
  { name: 'corpse_h_b', draw: (ctx) => renderCorpse(ctx, FIGURE_SPECS.rifleman!, 1, PROP_ANCHOR_X, PROP_ANCHOR_Y, 1.9) },
  { name: 'corpse_h_c', draw: (ctx) => renderCorpse(ctx, FIGURE_SPECS.rifleman!, 2, PROP_ANCHOR_X, PROP_ANCHOR_Y, 3.4) },
  { name: 'corpse_z_a', draw: (ctx) => renderCorpse(ctx, FIGURE_SPECS.walker!, 0, PROP_ANCHOR_X, PROP_ANCHOR_Y, 0.9) },
  { name: 'corpse_z_b', draw: (ctx) => renderCorpse(ctx, FIGURE_SPECS.walker!, 1, PROP_ANCHOR_X, PROP_ANCHOR_Y, 2.4) },
  { name: 'corpse_z_c', draw: (ctx) => renderCorpse(ctx, FIGURE_SPECS.walker!, 2, PROP_ANCHOR_X, PROP_ANCHOR_Y, 4.2) },
  { name: 'corpse_brute', draw: (ctx) => renderCorpse(ctx, FIGURE_SPECS.brute!, 0, PROP_ANCHOR_X, PROP_ANCHOR_Y, 1.2) },
];

function splat(ctx: CanvasRenderingContext2D, v: number): void {
  ctx.save();
  const n = 7 + v * 3;
  ctx.fillStyle = ['rgba(74,26,24,0.62)', 'rgba(58,20,18,0.58)', 'rgba(88,34,30,0.5)'][v]!;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const r = (0.9 + 0.55 * Math.sin(i * 2.7 + v * 3.1)) * S;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.58;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    const a = i * 1.9 + v;
    const d = (1.4 + 0.5 * i * (v + 1)) * S * 0.8;
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d * 0.6, 0.16 * S, 0.12 * S, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function buildProps(ctx: CanvasRenderingContext2D): Record<string, number> {
  const index: Record<string, number> = {};
  PROPS.forEach((p, i) => {
    const col = i % PROP_COLS, row = (i / PROP_COLS) | 0;
    index[p.name] = i;
    ctx.save();
    ctx.translate(col * PROP_CELL + PROP_ANCHOR_X, row * PROP_CELL + PROP_ANCHOR_Y);
    p.draw(ctx, 0);
    ctx.restore();
  });
  return index;
}

/** UI/diagnostic helper: dump the unit atlas (first N type blocks) to a data URL. */
export function atlasToDataURL(c: HTMLCanvasElement): string { return c.toDataURL('image/png'); }

export type { AnimName };
