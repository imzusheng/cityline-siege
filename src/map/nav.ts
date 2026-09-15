// Navigation grid + multi-source flow field. Zombies follow the field when they
// have no local target; humans use it only as a fallback so orders always win.

import { NAV, NAV_W, NAV_H, WORLD_W, WORLD_H } from '../core/config';
import { clamp } from '../core/math';

const DIAG = Math.SQRT2 - 1;

export class NavGrid {
  readonly w = NAV_W;
  readonly h = NAV_H;
  readonly cell = NAV;
  /** 1 = building / impassable */
  readonly blocked = new Uint8Array(NAV_W * NAV_H);
  /** 1 = fast (road), 2 = normal, 3 = slow (park / rubble) */
  readonly cost = new Uint8Array(NAV_W * NAV_H).fill(2);
  /** Extra traversal penalty used by the flow field (crowd pressure smoothing). */
  readonly heat = new Float32Array(NAV_W * NAV_H);

  readonly dist = new Float32Array(NAV_W * NAV_H);
  readonly flowX = new Float32Array(NAV_W * NAV_H);
  readonly flowY = new Float32Array(NAV_W * NAV_H);
  private queue = new Int32Array(NAV_W * NAV_H);
  private stamp = new Int32Array(NAV_W * NAV_H);

  idx(cx: number, cy: number): number { return cy * NAV_W + cx; }

  cellOf(x: number, y: number): number {
    const cx = clamp((x / NAV) | 0, 0, NAV_W - 1);
    const cy = clamp((y / NAV) | 0, 0, NAV_H - 1);
    return cy * NAV_W + cx;
  }

  isOpenWorld(x: number, y: number): boolean {
    if (x < 2 || y < 2 || x > WORLD_W - 2 || y > WORLD_H - 2) return false;
    return this.blocked[this.cellOf(x, y)] === 0;
  }

  isBlockedCell(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= NAV_W || cy >= NAV_H) return true;
    return this.blocked[cy * NAV_W + cx] !== 0;
  }

  /** Fill a world-space rectangle as blocked. */
  block(x: number, y: number, w: number, h: number): void {
    const x0 = clamp(Math.floor(x / NAV), 0, NAV_W - 1);
    const x1 = clamp(Math.ceil((x + w) / NAV), 0, NAV_W - 1);
    const y0 = clamp(Math.floor(y / NAV), 0, NAV_H - 1);
    const y1 = clamp(Math.ceil((y + h) / NAV), 0, NAV_H - 1);
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * NAV_W;
      for (let cx = x0; cx <= x1; cx++) this.blocked[row + cx] = 1;
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const x0 = clamp(Math.floor(x / NAV), 0, NAV_W - 1);
    const x1 = clamp(Math.ceil((x + w) / NAV), 0, NAV_W - 1);
    const y0 = clamp(Math.floor(y / NAV), 0, NAV_H - 1);
    const y1 = clamp(Math.ceil((y + h) / NAV), 0, NAV_H - 1);
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * NAV_W;
      for (let cx = x0; cx <= x1; cx++) this.blocked[row + cx] = 0;
    }
  }

  setCostRect(x: number, y: number, w: number, h: number, v: number): void {
    const x0 = clamp(Math.floor(x / NAV), 0, NAV_W - 1);
    const x1 = clamp(Math.ceil((x + w) / NAV), 0, NAV_W - 1);
    const y0 = clamp(Math.floor(y / NAV), 0, NAV_H - 1);
    const y1 = clamp(Math.ceil((y + h) / NAV), 0, NAV_H - 1);
    for (let cy = y0; cy <= y1; cy++) {
      const row = cy * NAV_W;
      for (let cx = x0; cx <= x1; cx++) this.cost[row + cx] = v;
    }
  }

  nearestOpen(x: number, y: number, maxR = 14): { x: number; y: number } {
    if (this.isOpenWorld(x, y)) return { x: clamp(x, 6, WORLD_W - 6), y: clamp(y, 6, WORLD_H - 6) };
    const cx = clamp((x / NAV) | 0, 0, NAV_W - 1);
    const cy = clamp((y / NAV) | 0, 0, NAV_H - 1);
    for (let r = 1; r <= maxR; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.abs(ox) !== r && Math.abs(oy) !== r) continue;
          const nx = cx + ox, ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= NAV_W || ny >= NAV_H) continue;
          if (!this.blocked[ny * NAV_W + nx]) return { x: (nx + 0.5) * NAV, y: (ny + 0.5) * NAV };
        }
      }
    }
    return { x: WORLD_W / 2, y: WORLD_H / 2 };
  }

  /** Coarse line of sight over the nav grid. */
  losClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.ceil(len / (NAV * 0.55));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.isOpenWorld(x0 + dx * t, y0 + dy * t)) return false;
    }
    return true;
  }

  /**
   * Multi-source BFS over open cells, weighted by terrain cost (Dial's buckets
   * keep it near-linear and avoid a heap allocation per rebuild).
   */
  buildFlow(targets: readonly { x: number; y: number }[], heatWeight = 1.0): void {
    const n = NAV_W * NAV_H;
    const dist = this.dist;
    dist.fill(1e9);
    this.flowX.fill(0);
    this.flowY.fill(0);
    const q = this.queue;
    const maxCost = 6;
    const buckets: number[][] = [];
    for (let i = 0; i < maxCost; i++) buckets.push([]);
    let queued = 0;
    for (const t of targets) {
      const c = this.cellOf(t.x, t.y);
      if (this.blocked[c]) continue;
      if (dist[c] !== 0) { dist[c] = 0; buckets[0]!.push(c); queued++; }
    }
    let cur = 0, scanned = 0;
    while (queued > 0 && scanned < n * 4) {
      const b = buckets[cur % maxCost]!;
      if (b.length === 0) { cur++; if (cur > n * 2) break; continue; }
      const c = b.pop()!;
      queued--;
      scanned++;
      const base = dist[c]!;
      const cx = c % NAV_W, cy = (c / NAV_W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= NAV_W || ny >= NAV_H) continue;
        const ni = ny * NAV_W + nx;
        if (this.blocked[ni]) continue;
        const step = this.cost[ni]! * 0.35 + this.heat[ni]! * heatWeight;
        const nd = base + step + 1;
        if (nd < dist[ni]! - 1e-4) {
          dist[ni] = nd;
          buckets[Math.round(nd) % maxCost]!.push(ni);
          queued++;
        }
      }
      if (b.length === 0) cur++;
    }
    // Gradient pass: pick the best of 8 neighbours.
    for (let cy = 0; cy < NAV_H; cy++) {
      for (let cx = 0; cx < NAV_W; cx++) {
        const i = cy * NAV_W + cx;
        if (this.blocked[i]) continue;
        const d0 = dist[i]!;
        let best = d0, bx = 0, by = 0;
        for (let k = 0; k < 8; k++) {
          const ox = k < 4 ? (k === 0 ? 1 : k === 1 ? -1 : 0) : 0;
          const oy = k < 4 ? (k === 2 ? 1 : k === 3 ? -1 : 0) : 0;
          const dxs = k >= 4 ? (k === 4 || k === 6 ? 1 : -1) : ox;
          const dys = k >= 4 ? (k === 4 || k === 5 ? 1 : -1) : oy;
          const nx = cx + dxs, ny = cy + dys;
          if (nx < 0 || ny < 0 || nx >= NAV_W || ny >= NAV_H) continue;
          const ni = ny * NAV_W + nx;
          if (this.blocked[ni]) continue;
          let pen = 0;
          if (dxs !== 0 && dys !== 0) {
            if (this.blocked[cy * NAV_W + nx] || this.blocked[ny * NAV_W + cx]) continue;
            pen = DIAG * 0.9;
          }
          const d = this.dist[ni]! + pen;
          if (d < best) { best = d; bx = dxs; by = dys; }
        }
        const l = Math.hypot(bx, by);
        if (l > 0) { this.flowX[i] = bx / l; this.flowY[i] = by / l; }
      }
    }
  }

  /** Sample the flow field with bilinear-ish smoothing. Returns a unit vector. */
  sampleFlow(x: number, y: number, out: { x: number; y: number }): void {
    const cx = clamp((x / NAV) | 0, 0, NAV_W - 1);
    const cy = clamp((y / NAV) | 0, 0, NAV_H - 1);
    let vx = 0, vy = 0, wsum = 0;
    for (let oy = -1; oy <= 1; oy++) {
      const ny = cy + oy;
      if (ny < 0 || ny >= NAV_H) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox;
        if (nx < 0 || nx >= NAV_W) continue;
        const i = ny * NAV_W + nx;
        if (this.blocked[i]) continue;
        const w = 1 / (1 + ox * ox + oy * oy);
        vx += this.flowX[i]! * w; vy += this.flowY[i]! * w; wsum += w;
      }
    }
    if (wsum < 1e-5) {
      // Escaped the field — fall back to the raw cell gradient.
      const i = cy * NAV_W + cx;
      vx = this.flowX[i]!; vy = this.flowY[i]!; wsum = 1;
    }
    const l = Math.hypot(vx, vy);
    if (l < 1e-4) { out.x = 0; out.y = 0; } else { out.x = vx / l; out.y = vy / l; }
  }

  /** Heuristic distance to the objective field; large when unreachable. */
  distAt(x: number, y: number): number { return this.dist[this.cellOf(x, y)]!; }

  decayHeat(dt: number): void {
    const heat = this.heat;
    for (let i = 0; i < heat.length; i++) {
      const v = heat[i]!;
      if (v > 0.001) heat[i] = v * Math.max(0, 1 - dt * 0.28);
      else if (v !== 0) heat[i] = 0;
    }
  }

  addHeat(x: number, y: number, amount: number, radius = 2): void {
    const cx = clamp((x / NAV) | 0, 0, NAV_W - 1);
    const cy = clamp((y / NAV) | 0, 0, NAV_H - 1);
    for (let oy = -radius; oy <= radius; oy++) {
      const ny = cy + oy; if (ny < 0 || ny >= NAV_H) continue;
      for (let ox = -radius; ox <= radius; ox++) {
        const nx = cx + ox; if (nx < 0 || nx >= NAV_W) continue;
        const i = ny * NAV_W + nx;
        if (this.blocked[i]) continue;
        const w = 1 - (Math.abs(ox) + Math.abs(oy)) / (radius * 2 + 1);
        const cur = this.heat[i]! + amount * w;
        this.heat[i] = cur > 6 ? 6 : cur;
      }
    }
  }

  /** Approximate blocked-cell scan used to keep units out of walls. */
  pushOutOfWalls(p: { x: number; y: number }, radius: number): void {
    const c = this.cellOf(p.x, p.y);
    if (!this.blocked[c]) return;
    const o = this.nearestOpen(p.x, p.y, 6);
    p.x = o.x; p.y = o.y;
  }
}
