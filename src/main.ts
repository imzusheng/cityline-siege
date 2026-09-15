// CITYLINE — bootstrap, fixed-step loop and the automation surface used by the
// headless playtest harness.

import { MAX_STEPS_PER_FRAME, SIM_DT, WORLD_H, WORLD_W } from './core/config';
import { generateCity, type City } from './map/city';
import { World } from './simulation/world';
import { Simulation } from './simulation/sim';
import { issueOrder, type LineOrder } from './simulation/orders';
import { Renderer } from './renderer/renderer';
import { createGL } from './renderer/glutil';
import { Camera } from './renderer/camera';
import { Input, type Tool } from './input/input';
import { Hud } from './ui/hud';
import { HUMAN_CLASSES } from './entities/types';
import type { HumanClass } from './core/config';

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const fxCanvas = document.getElementById('fx') as HTMLCanvasElement;

const hud = new Hud(fxCanvas);
const camera = new Camera();

let city: City;
let world: World;
let sim: Simulation;
let renderer: Renderer;
let input: Input;
let ready = false;
const gl = createGL(glCanvas);

let accumulator = 0;
let last = performance.now();
let fpsFrames = 0;
let fpsClock = 0;
let fps = 60;
let follow: { x: number; y: number } | null = null;
let uiClock = 0;
let running = false;

function deployInitial(world: World): void {
  const byClass = (i: number): HumanClass => {
    if (i % 9 === 0) return 'medic';
    if (i % 7 === 0) return 'gunner';
    if (i % 5 === 0) return 'breacher';
    return 'rifleman';
  };
  const objs = world.city.objectives;
  const groups: Array<{ x: number; y: number; n: number; ax: number; ay: number; bx: number; by: number }> = [];
  const o0 = objs[0]!, o1 = objs[1]!, o2 = objs[2]!;
  groups.push({ x: o0.x, y: o0.y + 150, n: 46, ax: o0.x - 150, ay: o0.y + 130, bx: o0.x + 150, by: o0.y + 130 });
  groups.push({ x: o1.x, y: o1.y + 130, n: 30, ax: o1.x - 110, ay: o1.y + 120, bx: o1.x + 110, by: o1.y + 120 });
  groups.push({ x: o2.x, y: o2.y + 120, n: 30, ax: o2.x - 120, ay: o2.y + 110, bx: o2.x + 120, by: o2.y + 110 });
  groups.push({ x: (o0.x + o1.x) / 2, y: (o0.y + o1.y) / 2, n: 22, ax: WORLD_W / 2 - 130, ay: WORLD_H / 2 - 120, bx: WORLD_W / 2 + 130, by: WORLD_H / 2 - 120 });

  let idx = 0;
  for (const g of groups) {
    const units = [] as ReturnType<World['makeHuman']>[];
    for (let i = 0; i < g.n; i++) {
      const a = (i / g.n) * Math.PI * 2;
      const r = 40 + (i % 5) * 16;
      const h = world.makeHuman(g.x + Math.cos(a) * r, g.y + Math.sin(a) * r * 0.8, byClass(idx));
      h.group = idx % 4;
      units.push(h);
      idx++;
    }
    const order = issueOrder(world, units, 'hold', g.ax, g.ay, g.bx, g.by);
    if (order) {
      order.refit = 2.5;
      order.slots.forEach((s, i) => { s.jx = Math.sin(i * 12.9898) * 1.6; s.jy = Math.sin(i * 78.233) * 2.4; });
    }
  }
  void HUMAN_CLASSES;
}

function init(): void {
  hud.setLoading('生成城市…');
  city = generateCity(0x51ed270b);
  world = new World(city, 0x9e3779b9);
  hud.setLoading('烘焙地面与建筑…');
  renderer = new Renderer(gl, camera, world);
  hud.setLoading('部署守军…');
  deployInitial(world);
  sim = new Simulation(world, {
    toast: (title, detail, kind) => hud.toast(title, detail, kind),
    rebuildFlow: () => sim.rebuildFlow(),
  });
  sim.onEnd = (r) => {
    running = false;
    hud.showResult(r === 'win', world);
  };
  sim.rebuildFlow();
  hud.buildObjectives(world);
  hud.resize(window.innerWidth, window.innerHeight);
  renderer.resize(window.innerWidth, window.innerHeight);
  camera.W = window.innerWidth; camera.H = window.innerHeight;
  camera.fitWorld();
  camera.sx = camera.x; camera.sy = camera.y; camera.srot = camera.rot; camera.szoom = camera.zoom;
  world.focusX = camera.x; world.focusY = camera.y;

  input = new Input(glCanvas, camera, world, {
    issueLine: (tool: Tool, ax, ay, bx, by) => {
      const units = world.humans.filter(h => h.alive && h.selected);
      if (!units.length) { hud.toast('没有选中部队', '先框选一片士兵，再拖出命令线'); return; }
      const order = issueOrder(world, units, tool === 'select' ? 'hold' : tool as never, ax, ay, bx, by);
      if (order) {
        const label = order.label;
        hud.toast(`${units.length} 人 · ${label}`, order.kind === 'advance' ? '部队将边打边推进' : order.kind === 'fallback' ? '脱离接触，重新组织' : '');
      }
      hud.setToolActive('select');
    },
    moveOrder: (x, y) => {
      const units = world.humans.filter(h => h.alive && h.selected);
      if (!units.length) return;
      const dx = x - (units[0]!.x), dy = y - (units[0]!.y);
      const l = Math.hypot(dx, dy) || 1;
      const px = -dy / l, py = dx / l;
      issueOrder(world, units, 'move', x - px * 60, y - py * 60, x + px * 60, y + py * 60);
      hud.setToolActive('select');
    },
    onTool: (t) => hud.setToolActive(t),
    onSelectionChanged: () => undefined,
    onHome: () => { camera.fitWorld(); follow = null; },
    onPause: () => { world.state.paused = !world.state.paused; hud.toast(world.state.paused ? '已暂停' : '继续'); },
    onFocus: (h) => { follow = h ? { x: h.x, y: h.y } : null; },
  });

  window.addEventListener('resize', () => {
    hud.resize(window.innerWidth, window.innerHeight);
    renderer.resize(window.innerWidth, window.innerHeight);
  });

  document.getElementById('btn-start')!.addEventListener('click', startGame);
  document.getElementById('btn-restart')!.addEventListener('click', restart);
  document.getElementById('btn-all')!.addEventListener('click', () => input.selectAll());
  document.getElementById('btn-home')!.addEventListener('click', () => { camera.fitWorld(); follow = null; });
  document.getElementById('btn-reinforce')!.addEventListener('click', () => callReinforcements());
  document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]').forEach(b => {
    b.addEventListener('click', () => input.setTool((b.dataset.tool ?? 'select') as Tool));
  });
  hud.enableStart(true);
  ready = true;
}

/** Three convoys of replacements arrive during a mission. */
function callReinforcements(): void {
  if (!world || world.state.reinforcements <= 0 || world.state.ended) {
    if (world && world.state.reinforcements <= 0) hud.toast('没有可用增援', '坚持到最后');
    return;
  }
  world.state.reinforcements--;
  const el = document.getElementById('reinf-n');
  if (el) el.textContent = String(world.state.reinforcements);
  const o = world.city.objectives[0]!;
  const units = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const h = world.makeHuman(o.x + Math.cos(a) * 90, o.y + 210 + Math.sin(a) * 60, i % 7 === 0 ? 'gunner' : i % 5 === 0 ? 'breacher' : i % 11 === 0 ? 'medic' : 'rifleman');
    h.selected = true;
    units.push(h);
  }
  const order = issueOrder(world, units, 'hold', camera.x - 150, camera.y + 40, camera.x + 150, camera.y + 40);
  if (order) order.refit = 2;
  hud.toast('增援纵队抵达', '24 名守军已加入，剩余增援 ' + world.state.reinforcements + ' 次');
}

function startGame(): void {
  hud.hideSplash();
  world.state.started = true;
  running = true;
  last = performance.now();
  accumulator = 0;
  hud.toast('战斗开始', '感染者正在从城市外围进入。看全局，再决定哪里值得守。', 'warn');
}

function restart(): void {
  hud.hideResult();
  const seed = (Math.random() * 0xffffffff) >>> 0;
  renderer.dispose();
  world.reset(generateCity(seed));
  renderer = new Renderer(gl, camera, world);
  deployInitial(world);
  sim = new Simulation(world, {
    toast: (title, detail, kind) => hud.toast(title, detail, kind),
    rebuildFlow: () => sim.rebuildFlow(),
  });
  sim.onEnd = (r) => { running = false; hud.showResult(r === 'win', world); };
  sim.rebuildFlow();
  hud.buildObjectives(world);
  (input as unknown as { world: World }).world = world;
  camera.fitWorld();
  camera.sx = camera.x; camera.sy = camera.y; camera.srot = camera.rot; camera.szoom = camera.zoom;
  startGame();
}

function resize(): void {
  if (!ready) return;
  const w = window.innerWidth, h = window.innerHeight;
  hud.resize(w, h);
  renderer.resize(w, h);
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fpsFrames++; fpsClock += dt;
  if (fpsClock >= 0.5) { fps = fpsFrames / fpsClock; fpsFrames = 0; fpsClock = 0; }
  if (!ready) return;

  camera.update(dt);
  if (follow) {
    const near = nearestSelected();
    if (near) { follow.x = near.x; follow.y = near.y; }
    else follow = null;
  }
  if (follow) {
    camera.x += (follow.x - camera.x) * Math.min(1, dt * 6);
    camera.y += (follow.y - camera.y) * Math.min(1, dt * 6);
  }
  if (running && !world.state.paused) input.update(dt);

  if (running && !world.state.paused && !world.state.ended) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      sim.step(SIM_DT);
      accumulator -= SIM_DT;
      steps++;
    }
    if (accumulator > SIM_DT * MAX_STEPS_PER_FRAME) accumulator = 0;
  } else {
    accumulator = 0;
  }

  world.focusX = camera.sx;
  world.focusY = camera.sy;
  renderer.render(world);

  const st = input.pointer;
  const drawing = running && st.down && st.dragging && input.tool !== 'select' && !input.panning;
  const rect = running && st.down && st.dragging && input.tool === 'select' && !input.panning
    ? { x0: st.startX, y0: st.startY, x1: st.x, y1: st.y } : null;
  hud.drawOverlay(world, camera,
    drawing ? { ax: st.startWX, ay: st.startWY, bx: st.wx, by: st.wy, tool: input.tool } : null,
    rect);

  uiClock += dt;
  if (uiClock > 0.18) { uiClock = 0; hud.update(world, camera, fps, dt); }
}

function nearestSelected(): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bd = 1e18;
  const cx = camera.x, cy = camera.y;
  for (const h of world.humans) {
    if (!h.alive) continue;
    if (!h.selected) continue;
    const d = (h.x - cx) ** 2 + (h.y - cy) ** 2;
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

// Debug: dump the facade texture array as a contact sheet.
if (new URLSearchParams(location.search).get('debug') === 'facades') {
  import('./renderer/textures').then((m) => {
    const canvases = m.buildFacadeCanvases();
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;z-index:50;background:#2a2b28';
    const c = document.createElement('canvas');
    c.width = 8 * 256; c.height = 4 * 256;
    const ctx = c.getContext('2d')!;
    canvases.forEach((cv, i) => ctx.drawImage(cv, (i % 8) * 256, Math.floor(i / 8) * 256));
    holder.appendChild(c);
    document.body.appendChild(holder);
  });
}

// ------------------------------------------------------------------ boot
requestAnimationFrame((t) => {
  try {
    init();
    resize();
    last = t;
    requestAnimationFrame(frame);
  } catch (err) {
    const fatal = document.getElementById('fatal')!;
    fatal.classList.remove('hidden');
    fatal.innerHTML = `<div><h2>初始化失败</h2><p>${String((err as Error).message ?? err)}</p></div>`;
    console.error(err);
  }
});

// ------------------------------------------------------- automation surface
interface Snapshot {
  time: number; humans: number; zombies: number; kills: number; losses: number;
  objectives: number[]; zoom: number; rot: number; fps: number; ended: boolean;
  corpses: number; orders: number; drawCalls: number; unitsDrawn: number;
}

(window as unknown as Record<string, unknown>).__CITYLINE__ = {
  ready: () => ready,
  snapshot: (): Snapshot => ({
    time: world.state.time,
    humans: world.humanAlive,
    zombies: world.zombieAlive,
    kills: world.state.kills,
    losses: world.state.losses,
    objectives: world.city.objectives.map(o => Math.round(o.hp)),
    zoom: camera.zoom,
    rot: camera.rot,
    fps,
    ended: world.state.ended,
    corpses: world.corpses.length,
    orders: world.orders.size,
    drawCalls: renderer.stats.units,
    unitsDrawn: renderer.stats.units,
  }),
  start: () => startGame(),
  restart: () => restart(),
  pause: (v: boolean) => { world.state.paused = v; },
  /** advance the simulation without waiting for real time */
  step: (seconds: number) => {
    const wasPaused = world.state.paused;
    world.state.paused = false;
    const n = Math.floor(seconds / SIM_DT);
    for (let i = 0; i < n; i++) sim.step(SIM_DT);
    world.state.paused = wasPaused;
    hud.update(world, camera, fps, SIM_DT);
    return true;
  },
  camera: (x: number, y: number, zoom?: number) => {
    camera.focus(x, y, zoom);
    camera.sx = camera.x; camera.sy = camera.y;
    if (zoom !== undefined) camera.szoom = camera.zoom;
  },
  rotate: (r: number) => { camera.rot = r; camera.srot = r; },
  selectRect: (x0: number, y0: number, x1: number, y1: number, add = false) => {
    input.selectRect(x0, y0, x1, y1, add);
    let n = 0; for (const h of world.humans) if (h.alive && h.selected) n++;
    return n;
  },
  issue: (tool: Tool, ax: number, ay: number, bx: number, by: number) => {
    const units = world.humans.filter(h => h.alive && h.selected);
    const o: LineOrder | null = issueOrder(world, units, tool as never, ax, ay, bx, by);
    return o ? { id: o.id, members: units.length, slots: o.slots.length } : null;
  },
  selectAll: () => { input.selectAll(); return world.humanAlive; },
  danger: () => world.city.objectives.map(o => ({ name: o.name, hp: Math.round(o.hp), lost: o.lost })),
  stats: () => ({ ...renderer.stats, orders: world.orders.size }),
  passes: (p: Partial<{ ground: boolean; buildings: boolean; props: boolean; units: boolean; fx: boolean }>) => {
    Object.assign(renderer.debugPasses, p);
    return renderer.debugPasses;
  },
  world: () => world,
  renderer: () => renderer,
  firstHuman: () => {
    for (const h of world.humans) if (h.alive) return { x: h.x, y: h.y };
    return { x: 0, y: 0 };
  },
  firstZombie: () => {
    for (const z of world.zombies) if (z.alive) return { x: z.x, y: z.y };
    return { x: 0, y: 0 };
  },
  contact: () => {
    // point where the fighting is thickest: men with infected in their face
    let bestX = 3200, bestY = 2400, bestN = -1;
    for (const h of world.humans) {
      if (!h.alive) continue;
      let n = 0;
      world.hashZ.forEachNear(h.x, h.y, 55, (i) => { if (world.zombies[i]!.alive) n++; });
      if (n > bestN) { bestN = n; bestX = h.x; bestY = h.y; }
    }
    return { x: bestX, y: bestY, n: bestN };
  },
  orderStats: () => {
    const out: Array<{ id: number; kind: string; members: number; slots: number; meanDist: number; state: string }> = [];
    for (const o of world.orders.values()) {
      let n = 0, d = 0, states: Record<string, number> = {};
      for (const h of world.humans) {
        if (!h.alive || h.orderId !== o.id) continue;
        n++;
        const s = o.slots[h.slotIndex];
        d += Math.hypot(h.x - (s ? s.x : o.bx), h.y - (s ? s.y : o.by));
        states[h.state] = (states[h.state] ?? 0) + 1;
      }
      const top = Object.entries(states).sort((a, b) => b[1] - a[1])[0];
      out.push({ id: o.id, kind: o.kind, members: n, slots: o.slots.length, meanDist: n ? d / n : 0, state: top ? top[0] : '-' });
    }
    return out;
  },
  densest: () => {
    // coarse occupancy scan to point the camera at the biggest fight
    let bestX = 3200, bestY = 2400, bestN = -1;
    for (let x = 300; x < 6400; x += 420) {
      for (let y = 300; y < 4800; y += 420) {
        let n = 0;
        for (const z of world.zombies) {
          if (!z.alive) continue;
          if (Math.abs(z.x - x) < 420 && Math.abs(z.y - y) < 420) n++;
        }
        for (const h of world.humans) {
          if (!h.alive) continue;
          if (Math.abs(h.x - x) < 420 && Math.abs(h.y - y) < 420) n += 2;
        }
        if (n > bestN) { bestN = n; bestX = x; bestY = y; }
      }
    }
    return { x: bestX, y: bestY, n: bestN };
  },
  selectNear: (x: number, y: number, r: number) => {
    let n = 0;
    for (const h of world.humans) {
      if (!h.alive) continue;
      h.selected = (h.x - x) ** 2 + (h.y - y) ** 2 < r * r;
      if (h.selected) n++;
    }
    return n;
  },
};
