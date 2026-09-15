// Procedural city.
//
// Layout: a single global street lattice gives every district the same
// orientation, so streets are continuous and actually connect. Districts only
// modulate the lattice — how many cells a block spans, how wide its streets
// are, what gets built inside. Three authored diagonal boulevards break the
// grid, and an elevated rail viaduct cuts across the north-east.
//
// Outputs:
//   buildings / roads  -> renderer (extruded prisms, baked ground texture)
//   nav floors         -> NavGrid (blocked cells, road cost, flow field)
//   spawn + objective  -> simulation (pressure director, win/lose)

import { Rng, clamp, lerp } from '../core/math';
import { NAV, NAV_W, NAV_H, WORLD_W, WORLD_H } from '../core/config';
import { NavGrid } from './nav';

export type WallStyle = 'brick' | 'concrete' | 'panel' | 'glass' | 'metal' | 'hospital' | 'stone' | 'residential' | 'derelict';
export type GroundStyle = 'shopfront' | 'lobby' | 'warehouse' | 'entry' | 'clinic' | 'civic' | 'loading' | 'shutter';
export type RoofStyle = 'gravel' | 'tar' | 'metal' | 'tile';
export type RoofFeature = 'none' | 'tank' | 'helipad' | 'sawtooth' | 'vents' | 'garden' | 'antenna';

export interface Archetype {
  id: string;
  label: string;
  floors: [number, number];
  floorH: [number, number];
  size: [number, number, number, number];
  wall: WallStyle;
  ground: GroundStyle;
  roof: RoofStyle;
  feature: RoofFeature;
  detail: number;
  weight: number;
}

export const ARCHETYPES: Record<string, Archetype> = {
  house:      { id: 'house',      label: '老宅',    floors: [2, 4],  floorH: [10.0, 11.8], size: [52, 96, 52, 96],     wall: 'brick',       ground: 'entry',     roof: 'tile',   feature: 'none',    detail: 0.5, weight: 1.0 },
  rowhouse:   { id: 'rowhouse',   label: '联排',    floors: [3, 5],  floorH: [10.0, 11.6], size: [42, 62, 84, 150],    wall: 'brick',       ground: 'entry',     roof: 'tile',   feature: 'tank',    detail: 0.35, weight: 0.9 },
  derelict:   { id: 'derelict',   label: '弃屋',    floors: [1, 2],  floorH: [10.5, 12.6], size: [60, 130, 55, 120],   wall: 'derelict',    ground: 'shutter',   roof: 'tar',    feature: 'none',    detail: 0.2, weight: 0.45 },
  apartment:  { id: 'apartment',  label: '公寓',    floors: [3, 6],  floorH: [10.4, 11.6], size: [86, 165, 58, 110],   wall: 'residential', ground: 'entry',     roof: 'gravel', feature: 'tank',    detail: 0.6, weight: 1.0 },
  block:      { id: 'block',      label: '住宅楼',  floors: [5, 8], floorH: [10.4, 11.6], size: [86, 150, 86, 150],   wall: 'concrete',    ground: 'lobby',     roof: 'gravel', feature: 'vents',   detail: 0.7, weight: 0.75 },
  office:     { id: 'office',     label: '写字楼',  floors: [5, 9], floorH: [12.4, 14.4], size: [104, 185, 86, 165],  wall: 'glass',       ground: 'lobby',     roof: 'gravel', feature: 'vents',   detail: 0.8, weight: 0.9 },
  shop:       { id: 'shop',       label: '沿街商业', floors: [2, 3], floorH: [12.6, 14.8], size: [70, 148, 48, 92],   wall: 'panel',       ground: 'shopfront', roof: 'tar',    feature: 'vents',   detail: 0.8, weight: 0.85 },
  shopRow:    { id: 'shopRow',    label: '商业楼',  floors: [3, 5],  floorH: [12.0, 13.6], size: [78, 140, 58, 104],   wall: 'concrete',    ground: 'shopfront', roof: 'gravel', feature: 'vents',   detail: 0.75, weight: 0.8 },
  clinic:     { id: 'clinic',     label: '诊所',    floors: [3, 5],  floorH: [11.4, 12.8], size: [70, 120, 54, 96],    wall: 'hospital',    ground: 'clinic',    roof: 'gravel', feature: 'vents',   detail: 0.6, weight: 0.4 },
  mall:       { id: 'mall',       label: '商业中心', floors: [2, 4], floorH: [16.0, 19.0], size: [190, 330, 140, 250], wall: 'glass',       ground: 'shopfront', roof: 'gravel', feature: 'garden',  detail: 1.0, weight: 0.28 },
  warehouse:  { id: 'warehouse',  label: '仓库',    floors: [1, 1],  floorH: [17.0, 22.0], size: [110, 235, 85, 165],  wall: 'metal',       ground: 'loading',   roof: 'metal',  feature: 'sawtooth',detail: 0.5, weight: 1.1 },
  shed:       { id: 'shed',       label: '厂房',    floors: [1, 1],  floorH: [14.0, 19.0], size: [52, 125, 46, 105],   wall: 'metal',       ground: 'warehouse', roof: 'metal',  feature: 'vents',   detail: 0.3, weight: 0.8 },
  hospital:   { id: 'hospital',   label: '医院',    floors: [4, 7],  floorH: [11.8, 13.6], size: [200, 300, 118, 190], wall: 'hospital',    ground: 'clinic',    roof: 'gravel', feature: 'helipad', detail: 0.9, weight: 0.2 },
  civic:      { id: 'civic',      label: '市政厅',  floors: [3, 5],  floorH: [15.4, 18.2], size: [175, 255, 130, 190], wall: 'stone',       ground: 'civic',     roof: 'tile',   feature: 'garden',  detail: 1.0, weight: 0.2 },
  tower:      { id: 'tower',      label: '地标塔',  floors: [11, 16],floorH: [11.8, 13.6], size: [72, 108, 72, 108],   wall: 'glass',       ground: 'lobby',     roof: 'gravel', feature: 'antenna', detail: 0.9, weight: 0.18 },
};

export interface Building {
  id: number;
  cx: number; cy: number;
  w: number; d: number;
  rot: number;
  floors: number;
  floorH: number;
  height: number;
  arch: Archetype;
  roofVariation: number;
  /** 0 = intact, 1 = badly wrecked. Drives the facade wear variant. */
  damage: number;
  corners: Float32Array;
  district: number;
}

export interface Debris { x: number; y: number; kind: number; scale: number; }

export interface Road {
  pts: number[];
  width: number;
  kind: 'avenue' | 'street' | 'alley' | 'rail' | 'path';
  district: number;
}

export interface District {
  id: number;
  name: string;
  kind: 'oldtown' | 'residential' | 'commercial' | 'industrial' | 'civic' | 'hospital' | 'park' | 'storage';
  x: number; y: number; w: number; h: number;
  buildings: number[];
  spacing: number;
  density: number;
  ground: string;
  accent: string;
}

export interface TreeProp { x: number; y: number; r: number; kind: number; seed: number; rot: number; }
export interface Barricade { id: number; x: number; y: number; rot: number; hp: number; maxHp: number; alive: boolean; cellX: number; cellY: number; kind: number; }
export interface Objective { id: number; name: string; short: string; x: number; y: number; r: number; hp: number; maxHp: number; lost: boolean; }
export interface SpawnPoint { x: number; y: number; angle: number; weight: number; label: string; }

/** Exact AABB occupancy index — no grid rounding, so dense blocks can be filled. */
export class SolidIndex {
  readonly cell = 48;
  readonly cols: number;
  readonly rows: number;
  private buckets: number[][];
  readonly boxes: Float32Array;

  constructor(maxItems: number) {
    this.cols = Math.ceil(WORLD_W / this.cell);
    this.rows = Math.ceil(WORLD_H / this.cell);
    this.buckets = new Array(this.cols * this.rows);
    this.boxes = new Float32Array(maxItems * 4);
  }
  private bucket(x: number, y: number): number[] {
    const cx = clamp((x / this.cell) | 0, 0, this.cols - 1);
    const cy = clamp((y / this.cell) | 0, 0, this.rows - 1);
    let b = this.buckets[cy * this.cols + cx];
    if (!b) { b = []; this.buckets[cy * this.cols + cx] = b; }
    return b;
  }
  overlaps(minx: number, miny: number, maxx: number, maxy: number): boolean {
    const cx0 = clamp((minx / this.cell) | 0, 0, this.cols - 1);
    const cx1 = clamp((maxx / this.cell) | 0, 0, this.cols - 1);
    const cy0 = clamp((miny / this.cell) | 0, 0, this.rows - 1);
    const cy1 = clamp((maxy / this.cell) | 0, 0, this.rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const b = this.buckets[cy * this.cols + cx];
        if (!b) continue;
        for (const i of b) {
          const o = i * 4;
          if (minx < this.boxes[o + 2]! && maxx > this.boxes[o]! && miny < this.boxes[o + 3]! && maxy > this.boxes[o + 1]!) return true;
        }
      }
    }
    return false;
  }
  insert(id: number, minx: number, miny: number, maxx: number, maxy: number): void {
    const o = id * 4;
    this.boxes[o] = minx; this.boxes[o + 1] = miny; this.boxes[o + 2] = maxx; this.boxes[o + 3] = maxy;
    const cx0 = clamp((minx / this.cell) | 0, 0, this.cols - 1);
    const cx1 = clamp((maxx / this.cell) | 0, 0, this.cols - 1);
    const cy0 = clamp((miny / this.cell) | 0, 0, this.rows - 1);
    const cy1 = clamp((maxy / this.cell) | 0, 0, this.rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) this.bucket((cx + 0.5) * this.cell, (cy + 0.5) * this.cell).push(id);
    }
  }
}

export interface City {
  buildings: Building[];
  roads: Road[];
  districts: District[];
  trees: TreeProp[];
  debris: Debris[];
  barricades: Barricade[];
  objectives: Objective[];
  spawns: SpawnPoint[];
  nav: NavGrid;
  streetGrid: StreetGrid;
  solid: SolidIndex;
  blocks: Array<{ x: number; y: number; w: number; h: number; park: boolean }>;
  seed: number;
}

/** Occupancy bitmap used to reject overlapping footprints quickly. */
export class StreetGrid {
  readonly cell = 16;
  readonly cols = Math.ceil(WORLD_W / 16);
  readonly rows = Math.ceil(WORLD_H / 16);
  readonly road = new Uint8Array(this.cols * this.rows);
  readonly solid = new Uint8Array(this.cols * this.rows);
  readonly roadDist = new Float32Array(this.cols * this.rows).fill(999);

  markRoad(x: number, y: number): void {
    const cx = (x / this.cell) | 0, cy = (y / this.cell) | 0;
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return;
    this.road[cy * this.cols + cx] = 1;
  }
  isRoad(x: number, y: number): boolean {
    const cx = (x / this.cell) | 0, cy = (y / this.cell) | 0;
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return false;
    return this.road[cy * this.cols + cx] === 1;
  }
  roadDistAt(x: number, y: number): number {
    const cx = clamp((x / this.cell) | 0, 0, this.cols - 1), cy = clamp((y / this.cell) | 0, 0, this.rows - 1);
    return this.roadDist[cy * this.cols + cx]!;
  }
  markSolid(x0: number, y0: number, x1: number, y1: number): void {
    const ax = clamp(Math.floor(x0 / this.cell), 0, this.cols - 1), bx = clamp(Math.ceil(x1 / this.cell), 0, this.cols - 1);
    const ay = clamp(Math.floor(y0 / this.cell), 0, this.rows - 1), by = clamp(Math.ceil(y1 / this.cell), 0, this.rows - 1);
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) this.solid[y * this.cols + x] = 1;
  }
  overlapsSolid(x0: number, y0: number, x1: number, y1: number): boolean {
    const ax = clamp(Math.floor(x0 / this.cell), 0, this.cols - 1), bx = clamp(Math.ceil(x1 / this.cell), 0, this.cols - 1);
    const ay = clamp(Math.floor(y0 / this.cell), 0, this.rows - 1), by = clamp(Math.ceil(y1 / this.cell), 0, this.rows - 1);
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) if (this.solid[y * this.cols + x]) return true;
    return false;
  }
  computeRoadDistance(): void {
    const { cols, rows, roadDist, road } = this;
    const INF = 999;
    for (let i = 0; i < road.length; i++) roadDist[i] = road[i] ? 0 : INF;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        let d = roadDist[i]!;
        if (x > 0) d = Math.min(d, roadDist[i - 1]! + 1);
        if (y > 0) d = Math.min(d, roadDist[i - cols]! + 1);
        if (x > 0 && y > 0) d = Math.min(d, roadDist[i - cols - 1]! + 1.414);
        if (x < cols - 1 && y > 0) d = Math.min(d, roadDist[i - cols + 1]! + 1.414);
        roadDist[i] = d;
      }
    }
    for (let y = rows - 1; y >= 0; y--) {
      for (let x = cols - 1; x >= 0; x--) {
        const i = y * cols + x;
        let d = roadDist[i]!;
        if (x < cols - 1) d = Math.min(d, roadDist[i + 1]! + 1);
        if (y < rows - 1) d = Math.min(d, roadDist[i + cols]! + 1);
        if (x < cols - 1 && y < rows - 1) d = Math.min(d, roadDist[i + cols + 1]! + 1.414);
        if (x > 0 && y < rows - 1) d = Math.min(d, roadDist[i + cols - 1]! + 1.414);
        roadDist[i] = d;
      }
    }
  }
}

const DISTRICT_DEFS: Array<Omit<District, 'id' | 'buildings'>> = [
  { name: '住宅区',   kind: 'residential', x: 120,  y: 130,  w: 2230, h: 2230, spacing: 176, density: 1.15, ground: '#5b5f58', accent: '#6f746a' },
  { name: '医疗区',   kind: 'hospital',    x: 2440, y: 130,  w: 1050, h: 1350, spacing: 176, density: 0.75, ground: '#767c75', accent: '#8b918a' },
  { name: '商业区',   kind: 'commercial',  x: 3580, y: 130,  w: 2700, h: 2000, spacing: 176, density: 1.0,  ground: '#6a675d', accent: '#85816f' },
  { name: '中央政务区', kind: 'civic',     x: 2440, y: 1570, w: 1050, h: 950,  spacing: 176, density: 0.62, ground: '#878071', accent: '#9d9585' },
  { name: '东站前区', kind: 'commercial',  x: 3580, y: 2220, w: 2700, h: 720,  spacing: 176, density: 0.95, ground: '#635f56', accent: '#7d7a6a' },
  { name: '中央公园', kind: 'park',        x: 4300, y: 2990, w: 1340, h: 1140, spacing: 176, density: 0.0,  ground: '#4a6038', accent: '#5c7444' },
  { name: '老城区',   kind: 'oldtown',     x: 120,  y: 2450, w: 2240, h: 2230, spacing: 176, density: 1.4,  ground: '#6d6553', accent: '#877c64' },
  { name: '仓储带',   kind: 'storage',     x: 2440, y: 2610, w: 1050, h: 2070, spacing: 176, density: 1.0,  ground: '#605c52', accent: '#787264' },
  { name: '工业区',   kind: 'industrial',  x: 3580, y: 2990, w: 2700, h: 1690, spacing: 176, density: 0.95, ground: '#5e5a4e', accent: '#75705f' },
];

/** Global lattice pitch — every district shares it, so streets connect. */
export const PITCH = 176;
const LNX = Math.ceil(WORLD_W / PITCH);
const LNY = Math.ceil(WORLD_H / PITCH);

/** Street width by lattice index: every 5th is a boulevard, then streets, then lanes. */
export function streetWidthAt(i: number): number {
  if (i % 5 === 0) return i % 10 === 0 ? 58 : 44;
  if (i % 2 === 0) return 32;
  return 20;
}

function blockScaleOf(d: District | null): number {
  if (!d) return 1;
  switch (d.kind) {
    case 'park': return 999;
    case 'commercial': return 2;
    case 'industrial': return 2;
    case 'storage': return 2;
    case 'civic': return 2;
    case 'hospital': return 2;
    default: return 1;
  }
}

export const GEN_STATS = { candidates: 0, oob: 0, road: 0, solid: 0, small: 0, vacant: 0, placed: 0, blocks: 0 };

export function districtAt(city: City, x: number, y: number): District | null {
  for (const d of city.districts) {
    if (x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) return d;
  }
  return null;
}

export function generateCity(seed = 0x51ed270b): City {
  const rng = new Rng(seed);
  const city: City = {
    buildings: [], roads: [], districts: [], trees: [], debris: [], barricades: [],
    objectives: [], spawns: [], nav: new NavGrid(), streetGrid: new StreetGrid(), solid: new SolidIndex(4000), blocks: [], seed,
  };
  for (let i = 0; i < DISTRICT_DEFS.length; i++) city.districts.push({ ...DISTRICT_DEFS[i]!, id: i, buildings: [] });
  GEN_STATS.candidates = GEN_STATS.oob = GEN_STATS.road = GEN_STATS.solid = GEN_STATS.small = GEN_STATS.vacant = GEN_STATS.placed = GEN_STATS.blocks = 0;

  const sg = city.streetGrid;

  // ---------------------------------------------------------------- lattice
  // vSeg[i][j]: is there a vertical street at x = i*PITCH covering row j?
  const vSeg = new Uint8Array((LNX + 1) * LNY);
  const hSeg = new Uint8Array(LNX * (LNY + 1));
  const scaleCache = new Int16Array(LNX * LNY);
  for (let j = 0; j < LNY; j++) {
    for (let i = 0; i < LNX; i++) {
      const d = districtAt(city, (i + 0.5) * PITCH, (j + 0.5) * PITCH);
      scaleCache[j * LNX + i] = blockScaleOf(d);
    }
  }
  const scaleAt = (i: number, j: number): number => {
    const ci = clamp(i, 0, LNX - 1), cj = clamp(j, 0, LNY - 1);
    return scaleCache[cj * LNX + ci]!;
  };
  for (let i = 1; i < LNX; i++) {
    for (let j = 0; j < LNY; j++) {
      const sl = scaleAt(i - 1, j), sr = scaleAt(i, j);
      vSeg[i * LNY + j] = (i % sl === 0 || i % sr === 0) ? 1 : 0;
    }
  }
  for (let j = 1; j < LNY; j++) {
    for (let i = 0; i < LNX; i++) {
      const st = scaleAt(i, j - 1), sb = scaleAt(i, j);
      hSeg[j * LNX + i] = (j % st === 0 || j % sb === 0) ? 1 : 0;
    }
  }

  // emit road polylines as contiguous runs
  for (let i = 1; i < LNX; i++) {
    let j = 0;
    while (j < LNY) {
      if (!vSeg[i * LNY + j]) { j++; continue; }
      const j0 = j;
      while (j < LNY && vSeg[i * LNY + j]) j++;
      addRoad(city, [i * PITCH, j0 * PITCH, i * PITCH, j * PITCH], streetWidthAt(i), i % 5 === 0 ? 'avenue' : i % 2 === 0 ? 'street' : 'alley', -1);
    }
  }
  for (let j = 1; j < LNY; j++) {
    let i = 0;
    while (i < LNX) {
      if (!hSeg[j * LNX + i]) { i++; continue; }
      const i0 = i;
      while (i < LNX && hSeg[j * LNX + i]) i++;
      addRoad(city, [i0 * PITCH, j * PITCH, i * PITCH, j * PITCH], streetWidthAt(j), j % 5 === 0 ? 'avenue' : j % 2 === 0 ? 'street' : 'alley', -1);
    }
  }

  // ------------------------------------------------------------- boulevards
  // Three authored diagonals break the lattice like a real city's Broadway.
  city.roads.push(
    { pts: [0, 4300, 900, 3450, 1900, 2680, 2600, 2400], width: 54, kind: 'street', district: -1 },
    { pts: [6400, 900, 5400, 1500, 4300, 2150, 3300, 2450], width: 46, kind: 'street', district: -1 },
    { pts: [2600, 4800, 3100, 3800, 3400, 2800, 3700, 1800, 3900, 600], width: 42, kind: 'street', district: -1 },
  );
  // park loop road
  addRoad(city, [4360, 3040, 5580, 3040, 5580, 4090, 4360, 4090, 4360, 3040], 26, 'path', -1);

  // Elevated rail viaduct across the north-east.
  city.roads.push({ pts: [2400, 1710, 3600, 1660, 4700, 1730, 6400, 1660], width: 46, kind: 'rail', district: -1 });

  for (const r of city.roads) rasterizeRoad(sg, r);
  sg.computeRoadDistance();

  // ------------------------------------------------------------------ nav
  for (let i = 0; i < city.nav.blocked.length; i++) city.nav.blocked[i] = 0;
  for (let i = 0; i < city.nav.cost.length; i++) city.nav.cost[i] = 2;
  const B = 3;
  city.nav.block(-100, -100, WORLD_W + 200, 100 + B);
  city.nav.block(-100, WORLD_H - B, WORLD_W + 200, 200);
  city.nav.block(-100, -100, 100 + B, WORLD_H + 200);
  city.nav.block(WORLD_W - B, -100, 200, WORLD_H + 200);

  // ------------------------------------------------------------- blocks
  buildBlocks(city, vSeg, hSeg, rng);
  placeLandmarks(city, rng);
  bakeNavFromBuildings(city);

  for (let cy = 0; cy < NAV_H; cy++) {
    for (let cx = 0; cx < NAV_W; cx++) {
      const i = cy * NAV_W + cx;
      if (city.nav.blocked[i]) continue;
      const wx = (cx + 0.5) * NAV, wy = (cy + 0.5) * NAV;
      const rd = sg.roadDistAt(wx, wy) * sg.cell;
      if (rd < 44) city.nav.cost[i] = 1;
      else if (rd > 110) city.nav.cost[i] = 3;
      else city.nav.cost[i] = 2;
    }
  }

  scatterTrees(city, rng);
  scatterDebris(city, rng);
  placeBarricades(city, rng);
  defineObjectives(city);
  defineSpawns(city);
  return city;
}

function addRoad(city: City, pts: number[], width: number, kind: Road['kind'], district: number): void {
  city.roads.push({ pts, width, kind, district });
}

/**
 * Walk the lattice and collect maximal rectangles bounded by surviving streets,
 * then fill each one with lots.
 */
function buildBlocks(city: City, vSeg: Uint8Array, hSeg: Uint8Array, rng: Rng): void {
  const visited = new Uint8Array(LNX * LNY);
  for (let j = 0; j < LNY; j++) {
    for (let i = 0; i < LNX; i++) {
      if (visited[j * LNX + i]) continue;
      let w = 1;
      while (i + w < LNX && !vSeg[(i + w) * LNY + j]) w++;
      let h = 1;
      outer: while (j + h < LNY) {
        for (let k = 0; k < w; k++) if (hSeg[(j + h) * LNX + (i + k)]) break outer;
        h++;
      }
      for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) visited[(j + b) * LNX + (i + a)] = 1;
      const left = i === 0 ? 0 : i * PITCH + streetWidthAt(i) / 2;
      const right = i + w >= LNX ? WORLD_W : (i + w) * PITCH - streetWidthAt(i + w) / 2;
      const top = j === 0 ? 0 : j * PITCH + streetWidthAt(j) / 2;
      const bottom = j + h >= LNY ? WORLD_H : (j + h) * PITCH - streetWidthAt(j + h) / 2;
      const rect = { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top), park: false };
      if (rect.w < 30 || rect.h < 30) continue;
      const d = districtAt(city, rect.x + rect.w / 2, rect.y + rect.h / 2);
      rect.park = !!d && d.kind === 'park';
      city.blocks.push(rect);
      GEN_STATS.blocks++;
      if (!d || d.kind === 'park') continue;
      if (rng.next() > d.density) continue;
      placeBlock(city, d, rect, rng);
      d.buildings.push(-1);
      d.buildings.pop();
    }
  }
}

function lotTarget(d: District): number {
  switch (d.kind) {
    case 'oldtown': return 52;
    case 'residential': return 74;
    case 'commercial': return 96;
    case 'industrial': return 165;
    case 'storage': return 130;
    case 'civic': return 190;
    case 'hospital': return 210;
    default: return 90;
  }
}

function placeBlock(city: City, d: District, rect: { x: number; y: number; w: number; h: number }, rng: Rng): void {
  const inset = d.kind === 'oldtown' ? 7 : 10;
  const x0 = rect.x + inset, y0 = rect.y + inset;
  const w = rect.w - inset * 2, h = rect.h - inset * 2;
  if (w < 40 || h < 40) { GEN_STATS.small++; return; }
  const target = lotTarget(d);
  let nx = clamp(Math.round(w / target), 1, 3);
  let ny = clamp(Math.round(h / (target * 1.05)), 1, 3);
  if (nx === 1 && ny === 1 && w > 120 && h > 110) ny = 2;
  // occasionally one big volume takes the whole block
  if (w > 150 && h > 130 && rng.chance(0.22)) { nx = 1; ny = 1; }
  const lw = w / nx, lh = h / ny;
  for (let a = 0; a < nx; a++) {
    for (let b = 0; b < ny; b++) {
      GEN_STATS.candidates++;
      if (nx * ny > 1 && rng.chance(0.26)) { GEN_STATS.vacant++; continue; }
      const cx = x0 + (a + 0.5) * lw + rng.jitter(lw * 0.03);
      const cy = y0 + (b + 0.5) * lh + rng.jitter(lh * 0.03);
      // ~30% of every lot stays open: courtyards, parking, alleys the horde
      // can pour through and the camera can see through
      placeLot(city, d, cx, cy, lw * 0.58, lh * 0.58, rng.jitter(0.02), rng);
    }
  }
}

function placeLot(city: City, d: District, wx: number, wy: number, maxW: number, maxD: number, rot: number, rng: Rng): void {
  const arch = pickArchetype(d, rng);
  const size = Math.max(maxW, maxD);
  let bw = Math.min(rng.range(arch.size[0], arch.size[1]), maxW);
  let bd = Math.min(rng.range(arch.size[2], arch.size[3]), maxD);
  // small lots cannot host very small archetypes
  bw = Math.min(Math.max(bw, Math.min(34, maxW)), maxW);
  bd = Math.min(Math.max(bd, Math.min(32, maxD)), maxD);
  if (bw < 30 || bd < 28) { GEN_STATS.small++; return; }
  void size;

  const floors = rng.int(arch.floors[0], arch.floors[1]);
  const floorH = rng.range(arch.floorH[0], arch.floorH[1]);
  const height = floors * floorH;
  const b: Building = {
    id: city.buildings.length,
    cx: wx, cy: wy, w: bw, d: bd, rot, floors, floorH, height,
    arch, roofVariation: rng.next(), damage: rollDamage(rng), corners: new Float32Array(8), district: d.id,
  };
  const c = Math.cos(rot), s = Math.sin(rot);
  const hw = bw / 2, hd = bd / 2;
  const pts: Array<[number, number]> = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  for (let i = 0; i < 4; i++) {
    b.corners[i * 2] = wx + pts[i]![0] * c - pts[i]![1] * s;
    b.corners[i * 2 + 1] = wy + pts[i]![0] * s + pts[i]![1] * c;
  }
  if (footprintHitsRoad(city, b)) { GEN_STATS.road++; return; }
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (let i = 0; i < 4; i++) {
    minx = Math.min(minx, b.corners[i * 2]!); maxx = Math.max(maxx, b.corners[i * 2]!);
    miny = Math.min(miny, b.corners[i * 2 + 1]!); maxy = Math.max(maxy, b.corners[i * 2 + 1]!);
  }
  if (city.solid.overlaps(minx - 2, miny - 2, maxx + 2, maxy + 2)) { GEN_STATS.solid++; return; }
  city.solid.insert(b.id, minx, miny, maxx, maxy);
  GEN_STATS.placed++;
  city.buildings.push(b);
  d.buildings.push(b.id);
}

/** Most of the city is intact; a visible minority is worn or wrecked. */
function rollDamage(rng: Rng): number {
  const r = rng.next();
  if (r < 0.52) return 0;
  if (r < 0.80) return 0.15 + rng.next() * 0.35;
  return 0.62 + rng.next() * 0.38;
}

function pickArchetype(d: District, rng: Rng): Archetype {
  let pool: Archetype[];
  switch (d.kind) {
    case 'oldtown': pool = [ARCHETYPES.house!, ARCHETYPES.house!, ARCHETYPES.rowhouse!, ARCHETYPES.derelict!, ARCHETYPES.shop!]; break;
    case 'residential': pool = [ARCHETYPES.apartment!, ARCHETYPES.apartment!, ARCHETYPES.block!, ARCHETYPES.shopRow!, ARCHETYPES.house!, ARCHETYPES.clinic!]; break;
    case 'commercial': pool = [ARCHETYPES.office!, ARCHETYPES.shop!, ARCHETYPES.shopRow!, ARCHETYPES.mall!, ARCHETYPES.block!, ARCHETYPES.tower!]; break;
    case 'industrial': pool = [ARCHETYPES.warehouse!, ARCHETYPES.warehouse!, ARCHETYPES.shed!, ARCHETYPES.shed!]; break;
    case 'storage': pool = [ARCHETYPES.warehouse!, ARCHETYPES.shed!, ARCHETYPES.shed!]; break;
    case 'civic': pool = [ARCHETYPES.office!, ARCHETYPES.shop!, ARCHETYPES.block!]; break;
    case 'hospital': pool = [ARCHETYPES.block!, ARCHETYPES.office!, ARCHETYPES.apartment!]; break;
    default: pool = [ARCHETYPES.house!]; break;
  }
  let total = 0;
  for (const a of pool) total += a.weight;
  let r = rng.next() * total;
  for (const a of pool) { r -= a.weight; if (r <= 0) return a; }
  return pool[0]!;
}

function footprintHitsRoad(city: City, b: Building): boolean {
  const sg = city.streetGrid;
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const hw = b.w / 2 + 2, hd = b.d / 2 + 2;
  const pts: Array<[number, number]> = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, -hd], [0, hd], [-hw, 0], [hw, 0]];
  for (const [lx, ly] of pts) {
    const wx = b.cx + lx * c - ly * s, wy = b.cy + lx * s + ly * c;
    if (wx < 4 || wy < 4 || wx > WORLD_W - 4 || wy > WORLD_H - 4) return true;
    if (sg.isRoad(wx, wy)) return true;
    for (const [ox, oy] of [[-4, -4], [4, -4], [4, 4], [-4, 4]] as const) {
      if (sg.isRoad(wx + ox, wy + oy)) return true;
    }
  }
  return false;
}

function rasterizeRoad(sg: StreetGrid, r: Road): void {
  const hw = r.width * 0.5;
  for (let i = 0; i + 3 < r.pts.length; i += 2) {
    const x0 = r.pts[i]!, y0 = r.pts[i + 1]!;
    const x1 = r.pts[i + 2]!, y1 = r.pts[i + 3]!;
    const minx = Math.min(x0, x1) - hw, maxx = Math.max(x0, x1) + hw;
    const miny = Math.min(y0, y1) - hw, maxy = Math.max(y0, y1) + hw;
    const cx0 = clamp(Math.floor(minx / sg.cell), 0, sg.cols - 1);
    const cx1 = clamp(Math.ceil(maxx / sg.cell), 0, sg.cols - 1);
    const cy0 = clamp(Math.floor(miny / sg.cell), 0, sg.rows - 1);
    const cy1 = clamp(Math.ceil(maxy / sg.cell), 0, sg.rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const wx = (cx + 0.5) * sg.cell, wy = (cy + 0.5) * sg.cell;
        if (pointSegDist(wx, wy, x0, y0, x1, y1) <= hw) sg.road[cy * sg.cols + cx] = 1;
      }
    }
  }
}

function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function placeLandmarks(city: City, rng: Rng): void {
  const hosp = city.districts.find(x => x.kind === 'hospital')!;
  addLandmark(city, hosp, ARCHETYPES.hospital!, hosp.x + 300, hosp.y + 380, 0, 0.86);
  addLandmark(city, hosp, ARCHETYPES.office!, hosp.x + 760, hosp.y + 900, 0.12);
  const civic = city.districts.find(x => x.kind === 'civic')!;
  addLandmark(city, civic, ARCHETYPES.civic!, civic.x + civic.w * 0.5, civic.y + civic.h * 0.42, 0, 0.82);
  const comms = city.districts.filter(x => x.kind === 'commercial');
  addLandmark(city, comms[0]!, ARCHETYPES.mall!, comms[0]!.x + 900, comms[0]!.y + 1300, 0.06, 0.8);
  addLandmark(city, comms[0]!, ARCHETYPES.tower!, comms[0]!.x + 520, comms[0]!.y + 380, 0.1);
  addLandmark(city, comms[1] ?? comms[0]!, ARCHETYPES.tower!, (comms[1] ?? comms[0]!).x + 1200, (comms[1] ?? comms[0]!).y + 320, 0.1);
  const ind = city.districts.find(x => x.kind === 'industrial')!;
  addLandmark(city, ind, ARCHETYPES.warehouse!, ind.x + 900, ind.y + 700, -0.05, 1.1);
  void rng;
}

function addLandmark(city: City, d: District, arch: Archetype, cx: number, cy: number, rot: number, scale = 1): boolean {
  const floors = arch.floors[1];
  const floorH = (arch.floorH[0] + arch.floorH[1]) / 2;
  const bw = arch.size[1] * scale, bd = arch.size[3] * scale;
  const height = floors * floorH;
  for (let attempt = 0; attempt < 60; attempt++) {
    const a = attempt * 2.399;
    const r = attempt === 0 ? 0 : 30 + attempt * 16;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    if (px < 60 || py < 60 || px > WORLD_W - 60 || py > WORLD_H - 60) continue;
    const b: Building = {
      id: city.buildings.length, cx: px, cy: py, w: bw, d: bd, rot, floors, floorH, height,
      arch, roofVariation: 0.5, damage: rollDamage(new Rng(attempt * 7919 + arch.id.length)), corners: new Float32Array(8), district: d.id,
    };
    const c = Math.cos(rot), s = Math.sin(rot);
    const pts: Array<[number, number]> = [[-bw / 2, -bd / 2], [bw / 2, -bd / 2], [bw / 2, bd / 2], [-bw / 2, bd / 2]];
    for (let i = 0; i < 4; i++) {
      b.corners[i * 2] = px + pts[i]![0] * c - pts[i]![1] * s;
      b.corners[i * 2 + 1] = py + pts[i]![0] * s + pts[i]![1] * c;
    }
    if (footprintHitsRoad(city, b)) continue;
    let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
    for (let i = 0; i < 4; i++) {
      mnx = Math.min(mnx, b.corners[i * 2]!); mxx = Math.max(mxx, b.corners[i * 2]!);
      mny = Math.min(mny, b.corners[i * 2 + 1]!); mxy = Math.max(mxy, b.corners[i * 2 + 1]!);
    }
    if (city.solid.overlaps(mnx - 2, mny - 2, mxx + 2, mxy + 2)) continue;
    city.solid.insert(b.id, mnx, mny, mxx, mxy);
    city.buildings.push(b);
    d.buildings.push(b.id);
    return true;
  }
  return false;
}

function bakeNavFromBuildings(city: City): void {
  const nav = city.nav;
  for (const b of city.buildings) {
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    const hw = b.w / 2, hd = b.d / 2;
    const minx = Math.min(b.corners[0]!, b.corners[2]!, b.corners[4]!, b.corners[6]!);
    const maxx = Math.max(b.corners[0]!, b.corners[2]!, b.corners[4]!, b.corners[6]!);
    const miny = Math.min(b.corners[1]!, b.corners[3]!, b.corners[5]!, b.corners[7]!);
    const maxy = Math.max(b.corners[1]!, b.corners[3]!, b.corners[5]!, b.corners[7]!);
    const x0 = clamp(Math.floor(minx / NAV), 0, NAV_W - 1), x1 = clamp(Math.ceil(maxx / NAV), 0, NAV_W - 1);
    const y0 = clamp(Math.floor(miny / NAV), 0, NAV_H - 1), y1 = clamp(Math.ceil(maxy / NAV), 0, NAV_H - 1);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const wx = (cx + 0.5) * NAV - b.cx, wy = (cy + 0.5) * NAV - b.cy;
        const lx = wx * c + wy * s;
        const ly = -wx * s + wy * c;
        if (Math.abs(lx) <= hw + 1.5 && Math.abs(ly) <= hd + 1.5) nav.blocked[cy * NAV_W + cx] = 1;
      }
    }
  }
  // Doorways: carve a small opening so interiors read as enterable.
  for (const b of city.buildings) {
    if (b.arch.id === 'warehouse' || b.arch.id === 'shed' || b.arch.id === 'mall') continue;
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    const edge = Math.floor((b.roofVariation * 4) % 4);
    const hw = b.w / 2, hd = b.d / 2;
    let lx = 0, ly = 0;
    if (edge === 0) { lx = 0; ly = -hd - 4; }
    else if (edge === 1) { lx = hw + 4; ly = 0; }
    else if (edge === 2) { lx = 0; ly = hd + 4; }
    else { lx = -hw - 4; ly = 0; }
    const wx = b.cx + lx * c - ly * s, wy = b.cy + lx * s + ly * c;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = clamp(((wx / NAV) | 0) + ox, 0, NAV_W - 1), gy = clamp(((wy / NAV) | 0) + oy, 0, NAV_H - 1);
      nav.blocked[gy * NAV_W + gx] = 0;
    }
  }
}

function scatterTrees(city: City, rng: Rng): void {
  for (const d of city.districts) {
    if (d.kind === 'park') {
      for (let i = 0; i < 2600; i++) {
        const x = rng.range(d.x + 20, d.x + d.w - 20), y = rng.range(d.y + 20, d.y + d.h - 20);
        if (city.nav.blocked[city.nav.cellOf(x, y)]) continue;
        const rd = city.streetGrid.roadDistAt(x, y) * city.streetGrid.cell;
        if (rd < 16) continue;
        city.trees.push({ x, y, r: rng.range(9, 17), kind: rng.chance(0.75) ? 0 : 1, seed: rng.next(), rot: rng.range(0, 6.28) });
      }
    } else {
      for (let i = 0; i < 90; i++) {
        const x = rng.range(d.x, d.x + d.w), y = rng.range(d.y, d.y + d.h);
        if (city.nav.blocked[city.nav.cellOf(x, y)]) continue;
        const rd = city.streetGrid.roadDistAt(x, y) * city.streetGrid.cell;
        if (rd > 13 && rd < 26) city.trees.push({ x, y, r: rng.range(8, 13), kind: 0, seed: rng.next(), rot: rng.range(0, 6.28) });
      }
    }
  }
}

function scatterDebris(city: City, rng: Rng): void {
  for (const b of city.buildings) {
    if (b.damage < 0.2) continue;
    const n = Math.round(b.damage * 6);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, 6.283);
      const r = (Math.max(b.w, b.d) * 0.5) * rng.range(0.9, 1.5);
      const x = b.cx + Math.cos(a) * r, y = b.cy + Math.sin(a) * r;
      if (!city.nav.isOpenWorld(x, y)) continue;
      city.debris.push({ x, y, kind: rng.chance(0.55) ? 0 : rng.chance(0.5) ? 1 : 2, scale: rng.range(0.6, 1.1) });
    }
  }
  // scattered street litter
  for (const d of city.districts) {
    for (let i = 0; i < 90; i++) {
      const x = rng.range(d.x, d.x + d.w), y = rng.range(d.y, d.y + d.h);
      if (!city.nav.isOpenWorld(x, y)) continue;
      const rd = city.streetGrid.roadDistAt(x, y) * city.streetGrid.cell;
      if (rd > 40) continue;
      city.debris.push({ x, y, kind: rng.int(0, 5), scale: rng.range(0.5, 0.95) });
    }
  }
}

function placeBarricades(city: City, rng: Rng): void {
  let id = 0;
  // Fortified positions around each objective: short sandbag lines with wide
  // gaps, so they read as cover the player can anchor on rather than a wall.
  for (const o of city.objectives) {
    const segs = 5;
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2 + 0.4;
      for (let k = 0; k < 3; k++) {
        const a = a0 + (k - 1) * 0.06;
        const x = o.x + Math.cos(a) * o.r * 0.94;
        const y = o.y + Math.sin(a) * o.r * 0.94;
        if (!city.nav.isOpenWorld(x, y)) continue;
        const hp = 520 + rng.range(0, 260);
        city.barricades.push({ id: id++, x, y, rot: a + Math.PI / 2, hp, maxHp: hp, alive: true, cellX: (x / NAV) | 0, cellY: (y / NAV) | 0, kind: rng.chance(0.5) ? 0 : 1 });
      }
    }
  }
  for (const d of city.districts) {
    const count = d.kind === 'oldtown' ? 22 : d.kind === 'storage' ? 14 : 10;
    for (let i = 0; i < count; i++) {
      const x = rng.range(d.x + 60, d.x + d.w - 60), y = rng.range(d.y + 60, d.y + d.h - 60);
      if (!city.nav.isOpenWorld(x, y)) continue;
      const rd = city.streetGrid.roadDistAt(x, y) * city.streetGrid.cell;
      if (rd > 22) continue;
      const rot = Math.atan2(rng.jitter(1), 1);
      const hp = 460 + rng.range(0, 260);
      city.barricades.push({ id: id++, x, y, rot, hp, maxHp: hp, alive: true, cellX: (x / NAV) | 0, cellY: (y / NAV) | 0, kind: rng.chance(0.5) ? 0 : 1 });
    }
  }
  for (const b of city.barricades) {
    if (b.alive) city.nav.blocked[b.cellY * NAV_W + b.cellX] = 1;
  }
}

function defineObjectives(city: City): void {
  const civic = city.districts.find(d => d.kind === 'civic')!;
  const hosp = city.districts.find(d => d.kind === 'hospital')!;
  const comm = city.districts.filter(d => d.kind === 'commercial')[1] ?? city.districts[2]!;
  city.objectives.push(
    { id: 0, name: '市政厅', short: 'CITY HALL', x: civic.x + civic.w * 0.5, y: civic.y + civic.h * 0.72, r: 120, hp: 100, maxHp: 100, lost: false },
    { id: 1, name: '医疗中心', short: 'MEDICAL', x: hosp.x + 230, y: hosp.y + 780, r: 105, hp: 100, maxHp: 100, lost: false },
    { id: 2, name: '撤离区', short: 'EVAC', x: comm.x + 260, y: comm.y + 620, r: 115, hp: 100, maxHp: 100, lost: false },
  );
}

function defineSpawns(city: City): void {
  const defs: Array<[number, number, number, string, number]> = [
    [340, 120, Math.PI / 2, '北 · 老工业干线', 1.0],
    [1180, 90, Math.PI / 2, '北 · 住宅区入口', 1.15],
    [2150, 130, Math.PI / 2, '北 · 主干道', 1.0],
    [3350, 110, Math.PI / 2, '北 · 商业大道', 1.05],
    [5150, 90, Math.PI / 2, '北 · 东站方向', 0.95],
    [6320, 900, Math.PI, '东 · 环城路', 1.1],
    [6280, 2050, Math.PI, '东 · 高架下', 0.9],
    [6250, 3000, Math.PI, '东 · 港区', 1.0],
    [5900, 4720, -Math.PI / 2, '南 · 铁路南侧', 0.95],
    [4300, 4740, -Math.PI / 2, '南 · 仓储带', 1.15],
    [2600, 4730, -Math.PI / 2, '南 · 老城尾', 1.2],
    [1200, 4740, -Math.PI / 2, '南 · 河道便桥', 0.9],
    [90, 3600, 0, '西 · 城西公路', 1.05],
    [110, 1600, 0, '西 · 住宅外围', 0.9],
  ];
  for (const [x, y, angle, label, weight] of defs) {
    const p = city.nav.nearestOpen(x, y, 20);
    city.spawns.push({ x: p.x, y: p.y, angle, weight, label });
  }
}

export { lerp };
