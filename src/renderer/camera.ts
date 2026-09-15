// Free 2D camera: pan, rotate, and zoom-to-cursor inside an axonometric world.

import { CAMERA, PITCH, ZSCALE, WORLD_W, WORLD_H } from '../core/config';
import { clamp, TAU } from '../core/math';

export class Camera {
  x = WORLD_W / 2;
  y = WORLD_H / 2;
  rot = Math.PI / 4;
  zoom = CAMERA.homeZoom;
  /** smoothed values used by the renderer */
  sx = this.x; sy = this.y; srot = this.rot; szoom = this.zoom;
  W = 1; H = 1;

  update(dt: number): void {
    const k = 1 - Math.pow(0.0016, dt);
    this.sx += (this.x - this.sx) * k;
    this.sy += (this.y - this.sy) * k;
    this.szoom += (this.zoom - this.szoom) * k;
    let dr = this.rot - this.srot;
    while (dr > Math.PI) dr -= TAU;
    while (dr < -Math.PI) dr += TAU;
    this.srot += dr * (1 - Math.pow(0.0009, dt));
  }

  /** cos/sin of -rot, matching worldToScreen. */
  get cosr(): number { return Math.cos(-this.srot); }
  get sinr(): number { return Math.sin(-this.srot); }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const dx = wx - this.sx, dy = wy - this.sy;
    const c = this.cosr, s = this.sinr;
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    return { x: rx * this.szoom + this.W / 2, y: (ry * PITCH) * this.szoom + this.H / 2 };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const rx = (sx - this.W / 2) / this.szoom;
    const ry = (sy - this.H / 2) / (this.szoom * PITCH);
    const c = Math.cos(this.srot), s = Math.sin(this.srot);
    return { x: this.sx + rx * c - ry * s, y: this.sy + rx * s + ry * c };
  }

  /** Screen px per world unit along the vertical axis (used to size sprites). */
  get verticalScale(): number { return ZSCALE * this.szoom; }

  /** Screen-space angle (unpitched) of a world direction vector. */
  screenAngle(vx: number, vy: number): number {
    const c = this.cosr, s = this.sinr;
    const rx = vx * c - vy * s;
    const ry = vx * s + vy * c;
    return Math.atan2(ry, rx);
  }

  panScreen(dxPx: number, dyPx: number): void {
    const rx = dxPx / this.szoom;
    const ry = dyPx / (this.szoom * PITCH);
    const c = Math.cos(this.srot), s = Math.sin(this.srot);
    this.x -= rx * c - ry * s;
    this.y -= rx * s + ry * c;
    this.clampPos();
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    this.zoom = clamp(this.zoom * factor, CAMERA.minZoom, CAMERA.maxZoom);
    // keep the world point under the cursor fixed (use target zoom directly)
    const z = this.zoom;
    const rx = (screenX - this.W / 2) / z;
    const ry = (screenY - this.H / 2) / (z * PITCH);
    const c = Math.cos(this.srot), s = Math.sin(this.srot);
    this.x = before.x - (rx * c - ry * s);
    this.y = before.y - (rx * s + ry * c);
    this.clampPos();
  }

  rotate(delta: number): void {
    this.rot += delta;
    while (this.rot > Math.PI) this.rot -= TAU;
    while (this.rot < -Math.PI) this.rot += TAU;
  }

  clampPos(): void {
    this.x = clamp(this.x, -1400, WORLD_W + 1400);
    this.y = clamp(this.y, -1400, WORLD_H + 1400);
  }

  fitWorld(): void {
    this.x = WORLD_W / 2; this.y = WORLD_H / 2;
    if (!Number.isFinite(this.rot)) this.rot = Math.PI / 4;
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    const c = this.cosr, s = this.sinr;
    for (const [x, y] of [[0, 0], [WORLD_W, 0], [0, WORLD_H], [WORLD_W, WORLD_H]] as const) {
      const dx = x - this.x, dy = y - this.y;
      const rx = dx * c - dy * s, ry = dx * s + dy * c;
      minx = Math.min(minx, rx); maxx = Math.max(maxx, rx);
      miny = Math.min(miny, ry * PITCH); maxy = Math.max(maxy, ry * PITCH);
    }
    const z = Math.min((this.W - 60) / (maxx - minx), (this.H - 170) / (maxy - miny));
    this.zoom = clamp(z, CAMERA.minZoom, CAMERA.maxZoom);
  }

  focus(x: number, y: number, zoom?: number): void {
    this.x = x; this.y = y;
    if (zoom !== undefined) this.zoom = clamp(zoom, CAMERA.minZoom, CAMERA.maxZoom);
  }
}
