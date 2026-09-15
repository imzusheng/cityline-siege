// Extrudes every building footprint into a lit prism: four facades split into a
// street-level band and per-floor window courses, a roof, a parapet and
// rooftop clutter. Also builds the elevated rail viaduct.

import type { City, Building } from '../map/city';
import { WALL_STYLE, GROUND_LAYER, ROOF_LAYER, wallLayer, VARIANT } from './textures';
import { Rng } from '../core/math';

export const VERTEX_FLOATS = 9; // x, y, z, u, v, layer, r, g, b
const GROUND_BAND = 9.0;        // ~2.25 m street level band
const FLOOR_TILE = 14.0;        // horizontal tile = 3.5 m (one window bay)
const GROUND_TILE = 20.0;       // street-level bays are wider than windows
const ROOF_TILE = 46.0;         // large so big roofs do not show a repeat motif

const SUN = (() => { const x = -0.52, y = -0.86; const l = Math.hypot(x, y); return { x: x / l, y: y / l }; })();

export interface MeshData { data: Float32Array; count: number; buildings: number; }

class MeshBuilder {
  private buf: Float32Array;
  private n = 0;
  constructor(cap: number) { this.buf = new Float32Array(cap * VERTEX_FLOATS); }
  private ensure(extra: number): void {
    if ((this.n + extra) * VERTEX_FLOATS <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < (this.n + extra) * VERTEX_FLOATS) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buf.subarray(0, this.n * VERTEX_FLOATS));
    this.buf = next;
  }
  vert(x: number, y: number, z: number, u: number, v: number, layer: number, r: number, g: number, b: number): void {
    const o = this.n * VERTEX_FLOATS;
    this.buf[o] = x; this.buf[o + 1] = y; this.buf[o + 2] = z;
    this.buf[o + 3] = u; this.buf[o + 4] = v; this.buf[o + 5] = layer;
    this.buf[o + 6] = r; this.buf[o + 7] = g; this.buf[o + 8] = b;
    this.n++;
  }
  quad(p0: number[], p1: number[], p2: number[], p3: number[], layer: number, light: number, tint: [number, number, number] = [1, 1, 1]): void {
    this.ensure(6);
    const r = light * tint[0], g = light * tint[1], b = light * tint[2];
    this.vert(p0[0]!, p0[1]!, p0[2]!, p0[3]!, p0[4]!, layer, r, g, b);
    this.vert(p1[0]!, p1[1]!, p1[2]!, p1[3]!, p1[4]!, layer, r, g, b);
    this.vert(p2[0]!, p2[1]!, p2[2]!, p2[3]!, p2[4]!, layer, r, g, b);
    this.vert(p0[0]!, p0[1]!, p0[2]!, p0[3]!, p0[4]!, layer, r, g, b);
    this.vert(p2[0]!, p2[1]!, p2[2]!, p2[3]!, p2[4]!, layer, r, g, b);
    this.vert(p3[0]!, p3[1]!, p3[2]!, p3[3]!, p3[4]!, layer, r, g, b);
  }
  box(cx: number, cy: number, z0: number, z1: number, w: number, d: number, rot: number, layer: number, light: number): void {
    const c = Math.cos(rot), s = Math.sin(rot);
    const pts: Array<[number, number]> = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
    const wp: Array<[number, number]> = pts.map(([px, py]) => [cx + px * c - py * s, cy + px * s + py * c]);
    for (let i = 0; i < 4; i++) {
      const a = wp[i]!, b = wp[(i + 1) % 4]!;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      const nx = dy / l, ny = -dx / l;
      const faceLight = light * (0.76 + 0.28 * Math.max(0, nx * SUN.x + ny * SUN.y));
      const ul = l / GROUND_TILE;
      this.quad(
        [a[0], a[1], z0, 0, 0], [b[0], b[1], z0, ul, 0], [b[0], b[1], z1, ul, (z1 - z0) / FLOOR_TILE], [a[0], a[1], z1, 0, (z1 - z0) / FLOOR_TILE],
        layer, faceLight,
      );
    }
    // top
    const hull = wp;
    this.quad(
      [hull[0]![0], hull[0]![1], z1, hull[0]![0] / ROOF_TILE, hull[0]![1] / ROOF_TILE],
      [hull[1]![0], hull[1]![1], z1, hull[1]![0] / ROOF_TILE, hull[1]![1] / ROOF_TILE],
      [hull[2]![0], hull[2]![1], z1, hull[2]![0] / ROOF_TILE, hull[2]![1] / ROOF_TILE],
      [hull[3]![0], hull[3]![1], z1, hull[3]![0] / ROOF_TILE, hull[3]![1] / ROOF_TILE],
      ROOF_LAYER.tar as number, light,
    );
  }
  finish(): Float32Array { return this.buf.slice(0, this.n * VERTEX_FLOATS); }
  get length(): number { return this.n; }
}

export function buildBuildingMesh(city: City): MeshData {
  const mb = new MeshBuilder(city.buildings.length * 260);
  const rng = new Rng(0x5bd1e995);

  for (const b of city.buildings) {
    emitBuilding(mb, b, rng);
  }
  emitViaduct(mb, city, rng);
  emitObjectives(mb, city);
  return { data: mb.finish(), count: mb.length, buildings: city.buildings.length };
}

function emitBuilding(mb: MeshBuilder, b: Building, rng: Rng): void {
  const style = WALL_STYLE[b.arch.wall] ?? 1;
  const variant = b.damage > 0.62 ? VARIANT.damaged : b.damage > 0.22 ? VARIANT.worn : VARIANT.intact;
  const wallLayerId = wallLayer(style, variant);
  const groundLayer = GROUND_LAYER[b.arch.ground] ?? 28;
  const roofLayer = ROOF_LAYER[b.arch.roof] ?? 30;
  // heavy damage shears the top floors off, leaving a jagged remnant
  const shear = b.damage > 0.7 ? Math.min(3, Math.round(b.damage * 4)) : 0;
  const fullH = b.height;
  const h = Math.max(b.floorH, fullH - shear * b.floorH);
  const bandTop = Math.min(GROUND_BAND, h * 0.4);
  const floorsAbove = Math.max(1, b.floors - 1);
  const floorBand = Math.max(4, (h - bandTop) / floorsAbove);
  const tr = b.roofVariation;
  const wallTint = 0.90 + tr * 0.22;
  // gentle warm/cool drift so a street of identical archetypes stops reading
  // as one stamped material
  const warm = (tr - 0.5) * 0.16;
  const tintR = 1 + warm;
  const tintB = 1 - warm * 1.1;
  const parapetH = b.arch.id === 'warehouse' || b.arch.id === 'shed' ? 5 : 7;

  for (let i = 0; i < 4; i++) {
    const a = [b.corners[i * 2]!, b.corners[i * 2 + 1]!] as const;
    const j = (i + 1) % 4;
    const c = [b.corners[j * 2]!, b.corners[j * 2 + 1]!] as const;
    const dx = c[0] - a[0], dy = c[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const nx = dy / len, ny = -dx / len;
    // the camera sees the south/east faces, so keep the ambient high enough
    // that they stay readable and the sun direction only adds modelling
    const lit = 0.68 + 0.32 * Math.max(0, nx * SUN.x + ny * SUN.y);
    // ground band
    mb.quad(
      [a[0], a[1], 0, 0, 0], [c[0], c[1], 0, len / GROUND_TILE, 0],
      [c[0], c[1], bandTop, len / GROUND_TILE, 1], [a[0], a[1], bandTop, 0, 1],
      groundLayer, lit * 0.96 * wallTint, [tintR, 1, tintB],
    );
    // upper floors, one texture tile per storey
    const rows = Math.max(1, Math.round((h - bandTop) / floorBand));
    for (let r = 0; r < rows; r++) {
      const z0 = bandTop + r * floorBand;
      const z1 = Math.min(h, z0 + floorBand);
      if (z1 - z0 < 0.6) break;
      mb.quad(
        [a[0], a[1], z0, 0, 0], [c[0], c[1], z0, len / FLOOR_TILE, 0],
        [c[0], c[1], z1, len / FLOOR_TILE, 1], [a[0], a[1], z1, 0, 1],
        wallLayerId, lit * wallTint * (r === 0 ? 1.02 : 1), [tintR, 1, tintB],
      );
    }
    // parapet rim
    const inset = 0.0;
    const px = nx * inset, py = ny * inset;
    mb.quad(
      [a[0] + px, a[1] + py, h, 0, 0], [c[0] + px, c[1] + py, h, len / FLOOR_TILE, 0],
      [c[0] + px, c[1] + py, h + parapetH, len / FLOOR_TILE, parapetH / FLOOR_TILE], [a[0] + px, a[1] + py, h + parapetH, 0, parapetH / FLOOR_TILE],
      wallLayerId, lit * 0.92, [tintR, 1, tintB],
    );
  }

  // roof slab
  const rc = b.corners;
  mb.quad(
    [rc[0]!, rc[1]!, h, rc[0]! / ROOF_TILE, rc[1]! / ROOF_TILE],
    [rc[2]!, rc[3]!, h, rc[2]! / ROOF_TILE, rc[3]! / ROOF_TILE],
    [rc[4]!, rc[5]!, h, rc[4]! / ROOF_TILE, rc[5]! / ROOF_TILE],
    [rc[6]!, rc[7]!, h, rc[6]! / ROOF_TILE, rc[7]! / ROOF_TILE],
    roofLayer, 1.08, [0.97 + tr * 0.08, 1.0, 0.95 + (1 - tr) * 0.08],
  );

  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const hw = b.w / 2, hd = b.d / 2;

  // blown-out upper floors: a jagged remnant of the original mass
  if (shear > 0) {
    const remH = fullH - h;
    const alongX = rng.chance(0.5);
    const frac = rng.range(0.35, 0.62);
    const rw = alongX ? b.w * frac : b.w;
    const rd = alongX ? b.d : b.d * frac;
    const ox = alongX ? (rng.chance(0.5) ? -1 : 1) * (b.w - rw) * 0.5 : 0;
    const oy = alongX ? 0 : (rng.chance(0.5) ? -1 : 1) * (b.d - rd) * 0.5;
    mb.box(b.cx + ox * c - oy * s, b.cy + ox * s + oy * c, h, h + remH, rw, rd, b.rot, wallLayerId, rng.range(0.68, 0.92));
    mb.box(b.cx, b.cy, h - 1.5, h + 1.5, b.w, b.d, b.rot, ROOF_LAYER.tar as number, 0.9);
  }

  // rooftop clutter
  const feature = b.arch.feature;
  const toWorld = (lx: number, ly: number): [number, number] => [b.cx + lx * c - ly * s, b.cy + lx * s + ly * c];
  const area = b.w * b.d;
  const small = area < 5200;
  // One stairwell / mechanical penthouse tucked into a corner (never centred,
  // never tall enough to read as a miniature house on the roof).
  if (!small) {
    const cxs = rng.chance(0.5) ? 1 : -1, cys = rng.chance(0.5) ? 1 : -1;
    const pw = Math.min(hw * 0.52, rng.range(20, 44));
    const pd = Math.min(hd * 0.52, rng.range(18, 38));
    const p = toWorld(cxs * (hw - pw * 0.7), cys * (hd - pd * 0.7));
    mb.box(p[0], p[1], h, h + rng.range(7, 12), pw, pd, b.rot, wallLayerId, 1.0);
  }
  // low plant: chillers, vents and pipe runs, all wider than they are tall
  const plantCount = small ? 1 : b.arch.detail > 0.6 ? 4 : 3;
  for (let k = 0; k < plantCount; k++) {
    const lx = rng.range(-hw * 0.72, hw * 0.72);
    const ly = rng.range(-hd * 0.72, hd * 0.72);
    const p = toWorld(lx, ly);
    const roll = rng.next();
    if (roll < 0.42) {
      // flat chiller package
      const w = Math.min(hw * 0.55, rng.range(16, 34));
      const d = Math.min(hd * 0.55, rng.range(14, 28));
      mb.box(p[0], p[1], h, h + rng.range(3.5, 6.5), w, d, b.rot + rng.jitter(0.2), ROOF_LAYER.metal as number, 0.92);
    } else if (roll < 0.76) {
      // pipe run lying along the roof
      const len = Math.min(b.w * 0.8, rng.range(40, 110));
      const alongX = rng.chance(0.5);
      mb.box(p[0], p[1], h, h + rng.range(2.4, 4.0), alongX ? len : 6, alongX ? 6 : len, b.rot, ROOF_LAYER.metal as number, 0.85);
    } else {
      // small vent stack cluster
      for (let v = 0; v < 3; v++) {
        mb.box(p[0] + rng.jitter(10), p[1] + rng.jitter(10), h, h + rng.range(4, 9), 5, 5, b.rot, ROOF_LAYER.metal as number, 0.8);
      }
    }
  }
  if (feature === 'tank') {
    const p = toWorld(rng.range(-hw * 0.5, hw * 0.5), rng.range(-hd * 0.5, hd * 0.5));
    const r = Math.min(hw, hd) * 0.22 + 6;
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
      mb.quad(
        [p[0] + Math.cos(a0) * r, p[1] + Math.sin(a0) * r, h, 0, 0],
        [p[0] + Math.cos(a1) * r, p[1] + Math.sin(a1) * r, h, 0.3, 0],
        [p[0] + Math.cos(a1) * r, p[1] + Math.sin(a1) * r, h + 42, 0.3, 1], [p[0] + Math.cos(a0) * r, p[1] + Math.sin(a0) * r, h + 42, 0, 1],
        ROOF_LAYER.metal as number, 0.7,
      );
    }
    mb.box(p[0], p[1], h + 42, h + 46, r * 2, r * 2, b.rot, ROOF_LAYER.metal as number, 1.0);
  } else if (feature === 'antenna') {
    const p = toWorld(0, 0);
    mb.box(p[0], p[1], h, h + rng.range(90, 170), 7, 7, b.rot, wallLayer(WALL_STYLE.metal!, VARIANT.intact) as number, 0.8);
    mb.box(p[0], p[1], h + 190, h + 214, 3.5, 3.5, b.rot, wallLayer(WALL_STYLE.metal!, VARIANT.intact) as number, 0.8);
  } else if (feature === 'helipad') {
    const p = toWorld(0, 0);
    for (let i = 0; i < 16; i++) {
      const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
      const r = 34;
      mb.quad(
        [p[0] + Math.cos(a0) * r, p[1] + Math.sin(a0) * r, h + 0.3, 0, 0],
        [p[0] + Math.cos(a1) * r, p[1] + Math.sin(a1) * r, h + 0.3, 0.1, 0],
        [p[0] + Math.cos(a1) * (r * 0.68), p[1] + Math.sin(a1) * (r * 0.68), h + 0.3, 0.1, 0.1],
        [p[0] + Math.cos(a0) * (r * 0.68), p[1] + Math.sin(a0) * (r * 0.68), h + 0.3, 0, 0.1],
        roofLayer, 1.25, [1.05, 1.05, 1.02],
      );
    }
  } else if (feature === 'sawtooth') {
    const n = Math.max(2, Math.floor(bwSafe(b) / 44));
    for (let i = 0; i < n; i++) {
      const lx = -hw + (i + 0.5) * (b.w / n);
      const p = toWorld(lx, 0);
      mb.box(p[0], p[1], h, h + rng.range(7, 13), b.w / n * 0.94, b.d * 0.9, b.rot, ROOF_LAYER.metal as number, 0.95);
    }
  } else if (feature === 'garden') {
    // shallow planting beds hugging the parapet
    const bed = 16;
    for (const sgn of [-1, 1]) {
      const p1 = toWorld(0, sgn * (hd - bed * 0.6));
      mb.box(p1[0], p1[1], h, h + rng.range(2.5, 4.5), b.w * 0.86, bed, b.rot, LAYER_GREEN, 1.0);
      const p2 = toWorld(sgn * (hw - bed * 0.6), 0);
      mb.box(p2[0], p2[1], h, h + rng.range(2.5, 4.5), bed, b.d * 0.7, b.rot, LAYER_GREEN, 1.0);
    }
  }
}

function bwSafe(b: Building): number { return b.w; }
const LAYER_GREEN = 13;

function emitViaduct(mb: MeshBuilder, city: City, rng: Rng): void {
  for (const r of city.roads) {
    if (r.kind !== 'rail') continue;
    const pierH = 78;
    const deckLo = pierH, deckHi = pierH + 14;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const x0 = r.pts[i]!, y0 = r.pts[i + 1]!, x1 = r.pts[i + 2]!, y1 = r.pts[i + 3]!;
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const steps = Math.max(2, Math.round(len / 90));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const px = x0 + dx * t, py = y0 + dy * t;
        if (rng.next() < 0.25) continue;
        mb.box(px, py, 0, pierH, 16, 22, ang, wallLayer(WALL_STYLE.concrete!, VARIANT.intact) as number, 0.9);
      }
      // deck: two side walls + top
      const segs = Math.max(2, Math.round(len / 160));
      for (let k = 0; k < segs; k++) {
        const t0 = k / segs, t1 = (k + 1) / segs;
        const ax = x0 + dx * t0, ay = y0 + dy * t0;
        const bx = x0 + dx * t1, by = y0 + dy * t1;
        const nx = -Math.sin(ang) * 26, ny = Math.cos(ang) * 26;
        for (const sgn of [-1, 1]) {
          mb.quad(
            [ax + nx * sgn, ay + ny * sgn, deckLo, 0, 0],
            [bx + nx * sgn, by + ny * sgn, deckLo, len / segs / 8, 0],
            [bx + nx * sgn, by + ny * sgn, deckHi, len / segs / 8, 1.4],
            [ax + nx * sgn, ay + ny * sgn, deckHi, 0, 1.4],
            wallLayer(WALL_STYLE.concrete!, VARIANT.intact) as number, sgn > 0 ? 0.95 : 0.65,
          );
        }
        mb.quad(
          [ax + nx, ay + ny, deckHi, 0, 0], [bx + nx, by + ny, deckHi, 0, 1],
          [bx - nx, by - ny, deckHi, 2, 1], [ax - nx, ay - ny, deckHi, 2, 0],
          ROOF_LAYER.tar as number, 1.0,
        );
      }
    }
  }
}

/** The objective ring used to be 24 concrete blocks placed on the zone radius —
 *  they read as random floating boxes and clipped through roads and buildings.
 *  The zone is painted into the ground texture instead, and fortified with
 *  sandbag positions in the city generator. */
function emitObjectives(_mb: MeshBuilder, _city: City): void { /* intentionally empty */ }
