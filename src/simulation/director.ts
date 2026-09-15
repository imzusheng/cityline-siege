// Dynamic pressure. There are no numbered waves: a schedule seeds the first
// contacts, then an adaptive controller keeps the city under mounting stress
// while a trickle of infected never stops arriving.

import { clamp } from '../core/math';
import { MISSION_SECONDS } from '../core/config';
import type { World } from './world';
import type { ZombieClass } from '../core/config';

export interface DirectorEvent {
  t: number;
  label: string;
  detail: string;
  count: number;
  spawns: number[];
  mix: Array<[ZombieClass, number]>;
  fired?: boolean;
}

const ALL_SPAWNS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const NORTH = [0, 1, 2, 3, 4];
const EAST = [5, 6, 7];
const SOUTH = [8, 9, 10, 11];
const WEST = [12, 13];

export const SCHEDULE: DirectorEvent[] = [
  { t: 0,    label: '外围出现零散感染者', detail: '城市边缘报告零星接触，保持警戒。', count: 130, spawns: [1, 4, 6, 9, 12], mix: [['walker', 1]] },
  { t: 40,   label: '北侧出现第一支尸群', detail: '约两百个感染者沿主干道向南推进。', count: 240, spawns: NORTH, mix: [['walker', 1]] },
  { t: 105,  label: '东侧商业区遭遇大规模尸潮', detail: '环城路方向涌来大批感染者。', count: 340, spawns: EAST, mix: [['walker', 0.95], ['runner', 0.05]] },
  { t: 170,  label: '西南出现疾行者', detail: '移动速度异常的目标正在穿插。', count: 150, spawns: [...SOUTH, ...WEST], mix: [['runner', 0.45], ['walker', 0.55]] },
  { t: 235,  label: '重躯接触', detail: '数个高大体型目标正在冲击人墙。', count: 90, spawns: ALL_SPAWNS, mix: [['walker', 0.9], ['brute', 0.1]] },
  { t: 300,  label: '多方向同时施压', detail: '南北两侧同时出现大股尸潮。', count: 430, spawns: [...NORTH, ...SOUTH], mix: [['walker', 0.88], ['runner', 0.09], ['brute', 0.03]] },
  { t: 395,  label: '东部城区被淹没', detail: '尸潮正在寻找防线的薄弱处。', count: 520, spawns: [...EAST, ...SOUTH], mix: [['walker', 0.85], ['runner', 0.12], ['brute', 0.02]] },
  { t: 490,  label: '尸潮规模持续扩大', detail: '感染体密度已经超过外围警戒线。', count: 600, spawns: ALL_SPAWNS, mix: [['walker', 0.84], ['runner', 0.13], ['brute', 0.03]] },
  { t: 600,  label: '全线压力', detail: '城市核心正在被包围。', count: 680, spawns: ALL_SPAWNS, mix: [['walker', 0.82], ['runner', 0.15], ['brute', 0.03]] },
  { t: 720,  label: '最后一波', detail: '所有方向都在报告大规模移动。', count: 760, spawns: ALL_SPAWNS, mix: [['walker', 0.8], ['runner', 0.16], ['brute', 0.04]] },
];

export interface DirectorState {
  trickleAcc: number;
  nextEvent: number;
  nextFlowRebuild: number;
  lastFlowRebuild: number;
  pressure: number;
  announced: number;
  districtAlerts: Map<number, number>;
}

export function makeDirectorState(): DirectorState {
  return { trickleAcc: 0, nextEvent: 0, nextFlowRebuild: 0, lastFlowRebuild: -99, pressure: 0, announced: 0, districtAlerts: new Map() };
}

export interface DirectorHooks {
  toast: (title: string, detail: string, kind?: 'info' | 'warn' | 'danger') => void;
  rebuildFlow: () => void;
}

export function updateDirector(world: World, d: DirectorState, dt: number, hooks: DirectorHooks): void {
  const t = world.state.time;

  // scheduled pressure
  while (d.nextEvent < SCHEDULE.length && SCHEDULE[d.nextEvent]!.t <= t) {
    const ev = SCHEDULE[d.nextEvent]!;
    spawnEvent(world, ev);
    hooks.toast(ev.label, ev.detail, ev.count > 300 ? 'danger' : 'warn');
    d.nextEvent++;
  }

  // continuous seepage keeps the streets alive between big pushes
  const ramp = 1 + Math.min(3.2, t / 240);
  const base = 5.5 * ramp;
  const adaptive = 1 + clamp((128 - world.state.losses) / 220, 0, 0.8);
  d.trickleAcc += dt * base * adaptive;
  const zombies = Math.max(1, world.zombieAlive);
  const cap = t < 170 ? 700 : t < 400 ? 1450 : t < 600 ? 2100 : 2800;
  if (zombies < cap) {
    while (d.trickleAcc >= 1) {
      d.trickleAcc -= 1;
      spawnOne(world, pickTrickleSpawn(world), trickleMix(t));
    }
  } else {
    d.trickleAcc = 0;
  }

  // re-route the horde around hard points as the battle evolves
  if (t - d.lastFlowRebuild > 3.4) {
    d.lastFlowRebuild = t;
    hooks.rebuildFlow();
  }
}

function trickleMix(t: number): ZombieClass {
  const r = Math.random();
  if (t > 260 && r < 0.035) return 'brute';
  if (t > 170 && r < 0.16) return 'runner';
  return 'walker';
}

function pickTrickleSpawn(world: World): number {
  // prefer edges that are currently quiet so the pressure feels directional
  const spawns = world.city.spawns;
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i]!;
    const near = world.nearestHuman(s.x, s.y, 1400);
    const d = near ? Math.hypot(near.x - s.x, near.y - s.y) : 1400;
    const score = d * (0.6 + Math.random() * 0.8) * s.weight;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function spawnEvent(world: World, ev: DirectorEvent): void {
  if (ev.fired) return;
  ev.fired = true;
  let made = 0;
  let guard = 0;
  const ceiling = 3400;
  while (made < ev.count && guard++ < ev.count * 6 && world.zombieAlive < ceiling) {
    const spawnIdx = ev.spawns[Math.floor(Math.random() * ev.spawns.length)]!;
    const cls = rollClass(ev.mix);
    if (spawnOne(world, spawnIdx, cls)) made++;
  }
}

function rollClass(mix: Array<[ZombieClass, number]>): ZombieClass {
  const r = Math.random();
  let acc = 0;
  for (const [c, w] of mix) { acc += w; if (r <= acc) return c; }
  return 'walker';
}

function spawnOne(world: World, spawnIdx: number, cls: ZombieClass): boolean {
  const s = world.city.spawns[spawnIdx];
  if (!s) return false;
  const a = s.angle + world.rng.jitter(0.7);
  const dist = world.rng.range(10, 150);
  const x = s.x + Math.cos(a + Math.PI / 2) * dist * 0.6 + Math.cos(s.angle) * world.rng.range(0, 60);
  const y = s.y + Math.sin(a + Math.PI / 2) * dist * 0.6 + Math.sin(s.angle) * world.rng.range(0, 60);
  world.makeZombie(x, y, cls);
  return true;
}

export function checkEndConditions(world: World): 'win' | 'lose' | null {
  if (world.state.ended) return null;
  if (world.objectivesLost() >= 3) return 'lose';
  if (world.humanAlive === 0) return 'lose';
  if (world.state.time >= MISSION_SECONDS) return 'win';
  return null;
}

/** Objectives bleed while infected are inside their ring. */
export function updateObjectives(world: World, dt: number): void {
  let total = 0;
  for (const o of world.city.objectives) {
    if (o.lost) continue;
    let threat = 0;
    world.hashZ.forEachNear(o.x, o.y, o.r + 20, (i) => {
      const z = world.zombies[i];
      if (!z || !z.alive) return;
      if (!z.alive) return;
      const dx = z.x - o.x, dy = z.y - o.y;
      if (dx * dx + dy * dy < (o.r + 20) * (o.r + 20)) threat++;
    });
    if (threat > 0) {
      // a node only bleeds while infected are actually inside the ring, and a
      // garrison of living soldiers slows the loss dramatically
      let guard = 0;
      world.hashH.forEachNear(o.x, o.y, o.r + 60, (i) => { if (world.humans[i]!.alive) guard++; });
      const held = 1 / (1 + guard * 0.22);
      const dmg = Math.min(threat, 70) * dt * 0.0092 * held;
      o.hp = Math.max(0, o.hp - dmg);
      if (o.hp <= 0) {
        o.lost = true;
        world.state.shake = Math.min(1, world.state.shake + 0.6);
      }
    }
    total += o.hp;
  }
  world.state.objectiveHp = total / Math.max(1, world.city.objectives.length);
}

export { MISSION_SECONDS };
