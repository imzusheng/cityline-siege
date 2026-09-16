// Mouse + keyboard. Selection, line drawing, free camera and the handful of
// shortcuts that keep the player's hands on the battlefield.

import { clamp } from '../core/math';
import { CAMERA } from '../core/config';
import type { Camera } from '../renderer/camera';
import type { Human, World } from '../simulation/world';

export type Tool = 'select' | 'hold' | 'advance' | 'fallback' | 'force';
/** Order issued by a plain click or a right-click: a tool, or the quick-move
 *  fallback that has no toolbar button of its own. */
export type ClickOrder = Tool | 'move';

export interface InputHooks {
  /** a drawn stroke becomes a formation line */
  issueLine(tool: Tool, ax: number, ay: number, bx: number, by: number): void;
  /** a single click becomes a short line centred on the point */
  orderAt(tool: ClickOrder, x: number, y: number): void;
  onTool(tool: Tool): void;
  onSelectionChanged(): void;
  onHome(): void;
  onPause(): void;
  onReinforce(): void;
  onFocus(h: Human | null): void;
}

export interface PointerState {
  x: number; y: number;
  wx: number; wy: number;
  down: boolean;
  button: number;
  dragging: boolean;
  startX: number; startY: number;
  startWX: number; startWY: number;
  shift: boolean;
}

export class Input {
  canvas: HTMLCanvasElement;
  camera: Camera;
  world: World;
  hooks: InputHooks;
  tool: Tool = 'select';
  pointer: PointerState = {
    x: 0, y: 0, wx: 0, wy: 0, down: false, button: 0, dragging: false,
    startX: 0, startY: 0, startWX: 0, startWY: 0, shift: false,
  };
  keys = new Set<string>();
  panning = false;
  private panX = 0; private panY = 0;
  private lastClickTime = 0;
  private lastClickX = 0;
  private lastClickY = 0;
  private enabled = true;

  constructor(canvas: HTMLCanvasElement, camera: Camera, world: World, hooks: InputHooks) {
    this.canvas = canvas;
    this.camera = camera;
    this.world = world;
    this.hooks = hooks;
    this.bind();
  }

  setEnabled(v: boolean): void { this.enabled = v; }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.onWheel(e); }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.pointer.down = false; this.panning = false; });
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    const p = this.local(e);
    const st = this.pointer;
    st.down = true; st.button = e.button; st.dragging = false;
    st.startX = p.x; st.startY = p.y;
    st.x = p.x; st.y = p.y;
    st.shift = e.shiftKey;
    const w = this.camera.screenToWorld(p.x, p.y);
    st.startWX = w.x; st.startWY = w.y;
    st.wx = w.x; st.wy = w.y;
    if (e.button === 1 || e.button === 2 || this.keys.has('Space')) {
      this.panning = true;
      this.panX = p.x; this.panY = p.y;
    }
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    const st = this.pointer;
    const dx = p.x - st.x, dy = p.y - st.y;
    st.x = p.x; st.y = p.y;
    const w = this.camera.screenToWorld(p.x, p.y);
    st.wx = w.x; st.wy = w.y;
    if (!st.down) return;
    if (Math.abs(p.x - st.startX) + Math.abs(p.y - st.startY) > 5) st.dragging = true;
    if (this.panning) {
      this.camera.panScreen(p.x - this.panX, p.y - this.panY);
      this.panX = p.x; this.panY = p.y;
    }
    void dx; void dy;
  }

  private onUp(e: PointerEvent): void {
    if (!this.enabled) return;
    const st = this.pointer;
    if (!st.down) return;
    const p = this.local(e);
    st.down = false;
    const wasPanning = this.panning;
    this.panning = false;

    // Right button: dragging pans the map, a click sends the selection there.
    // Claiming the press for panning up front used to make this order
    // unreachable, because every right press looked like a pan.
    if (e.button === 2) {
      if (!st.dragging) this.hooks.orderAt('move', st.wx, st.wy);
      return;
    }
    if (wasPanning) return;
    if (e.button !== 0) return;

    if (st.dragging) {
      if (this.tool === 'select') this.selectRect(st.startX, st.startY, p.x, p.y, e.shiftKey || st.shift);
      else this.hooks.issueLine(this.tool, st.startWX, st.startWY, st.wx, st.wy);
    } else {
      const now = performance.now();
      const dbl = now - this.lastClickTime < 320 && Math.abs(p.x - this.lastClickX) < 24 && Math.abs(p.y - this.lastClickY) < 24;
      this.lastClickTime = now; this.lastClickX = p.x; this.lastClickY = p.y;
      // Double-click picks up a nearby squad, but only while the selection tool
      // is armed: with a movement tool two quick clicks are two orders, not a
      // change of who is selected.
      if (this.tool !== 'select') this.hooks.orderAt(this.tool, st.wx, st.wy);
      else if (dbl) this.selectGroupAt(p.x, p.y);
      else this.selectAt(p.x, p.y, e.shiftKey);
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.enabled) return;
    const p = this.local(e);
    const factor = Math.pow(1.0016, -e.deltaY);
    this.camera.zoomAt(p.x, p.y, factor);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) { this.keys.add(e.code); return; }
    this.keys.add(e.code);
    switch (e.code) {
      case 'Digit1': this.setTool('select'); break;
      case 'Digit2': this.setTool('hold'); break;
      case 'Digit3': this.setTool('advance'); break;
      case 'Digit4': this.setTool('fallback'); break;
      case 'Digit5': this.setTool('force'); break;
      case 'KeyH': this.hooks.onHome(); break;
      case 'KeyR': this.hooks.onReinforce(); break;
      case 'Space': e.preventDefault(); this.hooks.onPause(); break;
      case 'Escape': this.clearSelection(); this.setTool('select'); break;
      // Select-all lives on the modifier that every other app uses for it: a
      // bare A is already the camera's pan-left key.
      case 'KeyA': if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.selectAll(); } break;
      default: break;
    }
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.canvas.style.cursor = t === 'select' ? 'crosshair' : 'copy';
    this.hooks.onTool(t);
  }

  update(dt: number): void {
    const k = this.keys;
    let dx = 0, dy = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) dy -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) dy += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) dx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) dx -= 1;
    if (k.has('KeyQ') && !k.has('ShiftLeft')) this.camera.rotate(-CAMERA.rotSpeed * dt);
    if (k.has('KeyE') && !k.has('ShiftLeft')) this.camera.rotate(CAMERA.rotSpeed * dt);
    if (dx || dy) {
      const l = Math.hypot(dx, dy) || 1;
      const s = CAMERA.panSpeed * dt / this.camera.szoom;
      this.camera.panScreen(-dx / l * s * this.camera.szoom, -dy / l * s * this.camera.szoom);
      this.hooks.onFocus(null);
    }
  }

  // ------------------------------------------------------------- selection

  selectRect(x0: number, y0: number, x1: number, y1: number, add: boolean): void {
    const minx = Math.min(x0, x1), maxx = Math.max(x0, x1);
    const miny = Math.min(y0, y1), maxy = Math.max(y0, y1);
    if (!add) for (const h of this.world.humans) h.selected = false;
    let n = 0;
    const cam = this.camera;
    for (const h of this.world.humans) {
      if (!h.alive) continue;
      const s = cam.worldToScreen(h.x, h.y);
      if (s.x >= minx && s.x <= maxx && s.y >= miny && s.y <= maxy) { h.selected = true; n++; }
    }
    if (n === 0) this.selectNearestToScreen((minx + maxx) / 2, (miny + maxy) / 2, add);
    this.hooks.onSelectionChanged();
  }

  private selectNearestToScreen(sx: number, sy: number, add: boolean): void {
    if (!add) for (const h of this.world.humans) h.selected = false;
    let best: Human | null = null;
    let bd = 46 * 46;
    for (const h of this.world.humans) {
      if (!h.alive) continue;
      const s = this.camera.worldToScreen(h.x, h.y);
      const d = (s.x - sx) ** 2 + (s.y - sy) ** 2;
      if (d < bd) { bd = d; best = h; }
    }
    if (best) { best.selected = true; this.selectGroupAround(best, 130); }
  }

  private selectAt(sx: number, sy: number, add: boolean): boolean {
    let best: Human | null = null;
    let bd = 26 * 26;
    for (const h of this.world.humans) {
      if (!h.alive) continue;
      const s = this.camera.worldToScreen(h.x, h.y);
      const d = (s.x - sx) ** 2 + (s.y - sy) ** 2;
      if (d < bd) { bd = d; best = h; }
    }
    if (!add) for (const h of this.world.humans) h.selected = false;
    if (best) { best.selected = true; this.selectGroupAround(best, 95); }
    this.hooks.onSelectionChanged();
    return !!best;
  }

  private selectGroupAt(sx: number, sy: number): void {
    let best: Human | null = null;
    let bd = 36 * 36;
    for (const h of this.world.humans) {
      if (!h.alive) continue;
      const s = this.camera.worldToScreen(h.x, h.y);
      const d = (s.x - sx) ** 2 + (s.y - sy) ** 2;
      if (d < bd) { bd = d; best = h; }
    }
    if (!best) return;
    for (const h of this.world.humans) h.selected = false;
    this.selectGroupAround(best, 240);
    this.hooks.onSelectionChanged();
    this.hooks.onFocus(best);
  }

  private selectGroupAround(center: Human, radius: number): void {
    const r2 = radius * radius;
    for (const h of this.world.humans) {
      if (!h.alive) continue;
      if ((h.x - center.x) ** 2 + (h.y - center.y) ** 2 < r2) h.selected = true;
    }
  }

  selectAll(): void {
    for (const h of this.world.humans) h.selected = h.alive;
    this.hooks.onSelectionChanged();
  }

  clearSelection(): void {
    for (const h of this.world.humans) h.selected = false;
    this.hooks.onSelectionChanged();
  }
}

export { clamp };
