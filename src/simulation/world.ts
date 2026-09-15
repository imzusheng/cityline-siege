// World state: every entity, every spatial query, and the mutation helpers
// shared by the AI systems.

import { SpatialHash } from '../core/spatial';
import { Rng, clamp, TAU } from '../core/math';
import {
  WORLD_W, WORLD_H, HUMAN_STATS, ZOMBIE_STATS, MORALE, SIM_DT,
  type HumanClass, type ZombieClass,
} from '../core/config';
import { makeAnimState, type AnimState } from '../entities/anim';
import { TYPE_INDEX } from '../entities/types';
import type { City, Objective } from '../map/city';
import { NavGrid } from '../map/nav';
import type { LineOrder } from './orders';

export type HumanState = 'MOVE' | 'DEPLOY' | 'HOLD' | 'ENGAGE' | 'RETREAT' | 'ROUT' | 'RECOVER';
export type ZombieState = 'FLOW' | 'CHASE' | 'ATTACK' | 'BREACH';
export type OrderKind = 'none' | 'hold' | 'advance' | 'fallback' | 'force' | 'move';

export interface Human {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  faceX: number; faceY: number;
  hp: number; maxHp: number;
  morale: number;
  cls: HumanClass;
  typeIndex: number;
  speed: number;
  alive: boolean;
  selected: boolean;
  state: HumanState;
  orderId: number;
  slotIndex: number;
  cool: number;
  aim: number;
  target: Zombie | null;
  retarget: number;
  anim: AnimState;
  movePhase: number;
  lastHit: number;
  stuck: number;
  lod: number;
  group: number;
  loseTrack: number;
  melee: number;
  suppress: number;
  aiTick: number;
  deadT: number;
  shotT: number;
  shotX: number;
  shotY: number;
  orderX: number;
  orderY: number;
}

export interface Zombie {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  faceX: number; faceY: number;
  hp: number; maxHp: number;
  cls: ZombieClass;
  typeIndex: number;
  speed: number;
  alive: boolean;
  state: ZombieState;
  target: Human | null;
  retarget: number;
  cool: number;
  anim: AnimState;
  movePhase: number;
  dx: number; dy: number;
  lod: number;
  aiTick: number;
  seed: number;
  breach: number;
  pressure: number;
  stagger: number;
  deadT: number;
  hitFlash: number;
}

export interface Corpse {
  x: number; y: number;
  cell: number;
  mirror: number;
  kind: number;
  t: number;
  tintR: number; tintG: number; tintB: number;
  alpha: number;
}

export interface Effect {
  kind: number; // 0 tracer, 1 flash, 2 blood, 3 dust, 4 spark, 5 ring
  x: number; y: number;
  x2: number; y2: number;
  t: number; max: number;
  scale: number;
  r: number; g: number; b: number;
  alpha: number;
}

export interface GameState {
  time: number;
  started: boolean;
  paused: boolean;
  ended: boolean;
  win: boolean;
  speed: number;
  losses: number;
  kills: number;
  reinforcements: number;
  objectiveHp: number;
  shake: number;
}

export const enum FX { TRACER = 0, FLASH = 1, BLOOD = 2, DUST = 3, SPARK = 4, RING = 5 }

const MAX_CORPSES = 2600;
const MAX_EFFECTS = 2600;

export class World {
  city: City;
  nav: NavGrid;
  rng: Rng;
  humans: Human[] = [];
  zombies: Zombie[] = [];
  corpses: Corpse[] = [];
  effects: Effect[] = [];
  state: GameState = {
    time: 0, started: false, paused: false, ended: false, win: false, speed: 1,
    losses: 0, kills: 0, reinforcements: 3, objectiveHp: 100, shake: 0,
  };
  hashH: SpatialHash;
  hashZ: SpatialHash;
  private nextId = 1;
  /** transient per-tick counters for the HUD */
  humanAlive = 0;
  zombieAlive = 0;
  /** scratch */
  private tmp = { x: 0, y: 0 };
  orderSeq = 1;
  orders = new Map<number, LineOrder>();
  focusX = WORLD_W / 2;
  focusY = WORLD_H / 2;

  constructor(city: City, seed = 0x9e3779b9) {
    this.city = city;
    this.nav = city.nav;
    this.rng = new Rng(seed);
    this.hashH = new SpatialHash(WORLD_W, WORLD_H, 48);
    this.hashZ = new SpatialHash(WORLD_W, WORLD_H, 48);
  }

  // ---------------------------------------------------------------- entities

  makeHuman(x: number, y: number, cls: HumanClass, group = 0): Human {
    const st = HUMAN_STATS[cls];
    const p = this.nav.nearestOpen(x, y, 10);
    const a = this.rng.range(0, TAU);
    const h: Human = {
      id: this.nextId++,
      x: p.x, y: p.y, vx: 0, vy: 0,
      faceX: Math.cos(a), faceY: Math.sin(a),
      hp: st.hp, maxHp: st.hp,
      morale: MORALE.base + this.rng.jitter(6),
      cls, typeIndex: TYPE_INDEX[cls]!,
      speed: st.speed * this.rng.range(0.94, 1.06),
      alive: true, selected: false,
      state: 'HOLD', orderId: 0, slotIndex: -1,
      cool: this.rng.range(0, st.cooldown),
      aim: 0, target: null, retarget: this.rng.range(0, 0.3),
      anim: makeAnimState(),
      movePhase: this.rng.range(0, 1),
      lastHit: -99, stuck: 0, lod: 0, group, loseTrack: 0, melee: 0, suppress: 0,
      aiTick: this.rng.range(0, SIM_DT * 4),
      deadT: 0, shotT: 0, shotX: 0, shotY: 0, orderX: p.x, orderY: p.y,
    };
    this.humans.push(h);
    return h;
  }

  makeZombie(x: number, y: number, cls: ZombieClass): Zombie {
    const st = ZOMBIE_STATS[cls];
    const p = this.nav.nearestOpen(x, y, 14);
    const a = this.rng.range(0, TAU);
    const z: Zombie = {
      id: this.nextId++,
      x: p.x, y: p.y, vx: 0, vy: 0,
      faceX: Math.cos(a), faceY: Math.sin(a),
      hp: st.hp, maxHp: st.hp,
      cls, typeIndex: TYPE_INDEX[cls]!,
      speed: st.speed * (1 + this.rng.jitter(st.speedVar)),
      alive: true, state: 'FLOW', target: null,
      retarget: this.rng.range(0, 0.5), cool: this.rng.range(0, 1),
      anim: makeAnimState(), movePhase: this.rng.range(0, 1),
      dx: Math.cos(a), dy: Math.sin(a),
      lod: 0, aiTick: this.rng.range(0, SIM_DT * 6), seed: this.rng.next(),
      breach: 0, pressure: 0, stagger: 0, deadT: 0, hitFlash: 0,
    };
    this.zombies.push(z);
    return z;
  }

  // ---------------------------------------------------------------- lifecycle

  killHuman(h: Human, _by?: Zombie): void {
    if (!h.alive) return;
    h.alive = false;
    h.selected = false;
    this.state.losses++;
    this.addCorpse(h.x, h.y, h.cls === 'medic' ? 1 : 0, 0, true);
    this.addEffect(FX.BLOOD, h.x, h.y, 0, 0, 0.9, 22, 0.42, 0.16, 0.14, 0.8);
    this.affectMorale(h.x, h.y, MORALE.radius, 9 + this.rng.range(0, 5));
  }

  killZombie(z: Zombie): void {
    if (!z.alive) return;
    z.alive = false;
    this.state.kills++;
    const brute = z.cls === 'brute';
    this.addCorpse(z.x, z.y, brute ? 2 : 1, 1, false);
    if (this.rng.chance(brute ? 1 : 0.5)) {
      this.addEffect(FX.BLOOD, z.x, z.y, 0, 0, 0.55, brute ? 26 : 16, 0.36, 0.13, 0.12, 0.75);
    }
  }

  addCorpse(x: number, y: number, variant: number, faction: number, human: boolean): void {
    if (this.corpses.length >= MAX_CORPSES) {
      // recycle the oldest slot rather than growing forever
      this.corpses.shift();
    }
    const v = variant % 3;
    const cell = human
      ? [15, 16, 17][v]!
      : [18, 19, 20][v]!;
    const mirror = this.rng.chance(0.5) ? 1 : 0;
    this.corpses.push({
      x, y, cell, mirror, kind: human ? 0 : 1, t: this.state.time,
      tintR: 1, tintG: 1, tintB: 1, alpha: 1,
    });
  }

  addEffect(kind: number, x: number, y: number, x2: number, y2: number, life: number, scale: number, r: number, g: number, b: number, alpha = 1): void {
    if (this.effects.length >= MAX_EFFECTS) this.effects.shift();
    this.effects.push({ kind, x, y, x2, y2, t: life, max: life, scale, r, g, b, alpha });
  }

  affectMorale(x: number, y: number, radius: number, amount: number): void {
    const r2 = radius * radius;
    this.hashH.forEachNear(x, y, radius, (i) => {
      const h = this.humans[i]!;
      if (!h.alive) return;
      const dx = h.x - x, dy = h.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return;
      const f = 1 - Math.sqrt(d2) / radius;
      h.morale = Math.max(0, h.morale - amount * (0.35 + f * 0.75));
    });
  }

  // ---------------------------------------------------------------- queries

  rebuildHashes(): void {
    const hh = this.hashH;
    const hz = this.hashZ;
    hh.clear();
    hz.clear();
    const humans = this.humans;
    for (let i = 0; i < humans.length; i++) {
      const h = humans[i]!;
      if (h.alive) hh.insert(i, h.x, h.y, humans.length);
    }
    const zs = this.zombies;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i]!;
      if (z.alive) hz.insert(i, z.x, z.y, zs.length);
    }
  }

  nearestHuman(x: number, y: number, radius: number): Human | null {
    let best: Human | null = null;
    let bd = radius * radius;
    this.hashH.forEachNear(x, y, radius, (i) => {
      const h = this.humans[i]!;
      if (!h.alive) return;
      const dx = h.x - x, dy = h.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = h; }
    });
    return best;
  }

  nearestZombie(x: number, y: number, radius: number, preferFront = true): Zombie | null {
    let best: Zombie | null = null;
    let bestScore = -1e9;
    const r2 = radius * radius;
    this.hashZ.forEachNear(x, y, radius, (i) => {
      const z = this.zombies[i]!;
      if (!z.alive) return;
      const dx = z.x - x, dy = z.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return;
      // prefer close targets that are already in front of the shooter
      const score = -d2 + (preferFront ? 0 : 0);
      if (score > bestScore) { bestScore = score; best = z; }
    });
    return best;
  }

  /** Sum of crowd weight around a point (used for panic and suppression). */
  crowdPressure(p: { x: number; y: number }, x: number, y: number, radius: number, maxN = 12): number {
    let n = 0;
    const r2 = radius * radius;
    this.hashZ.forEachNear(x, y, radius, (i) => {
      if (n >= maxN) return;
      const z = this.zombies[i]!;
      if (!z.alive) return;
      const dx = z.x - x, dy = z.y - y;
      if (dx * dx + dy * dy < r2) n++;
    });
    p.x = n;
    p.y = 0;
    return n;
  }

  aliveCounts(): void {
    let h = 0;
    for (const u of this.humans) if (u.alive) h++;
    let z = 0;
    for (const u of this.zombies) if (u.alive) z++;
    this.humanAlive = h;
    this.zombieAlive = z;
  }

  objectivesLost(): number {
    let n = 0;
    for (const o of this.city.objectives) if (o.lost) n++;
    return n;
  }

  objective(id: number): Objective { return this.city.objectives[id]!; }

  /** Remove entities that have been dead for a while, reclaiming memory. */
  compact(): void {
    if (this.zombies.length > 4200) {
      this.zombies = this.zombies.filter(z => z.alive);
    }
    if (this.humans.length > 400) {
      this.humans = this.humans.filter(h => h.alive);
    }
  }

  reset(city: City): void {
    this.city = city;
    this.nav = city.nav;
    this.humans.length = 0;
    this.zombies.length = 0;
    this.corpses.length = 0;
    this.effects.length = 0;
    this.orders.clear();
    // stale buckets would index into the new (empty) entity arrays
    this.hashH.clear();
    this.hashZ.clear();
    this.state = { time: 0, started: false, paused: false, ended: false, win: false, speed: 1, losses: 0, kills: 0, reinforcements: 3, objectiveHp: 100, shake: 0 };
    this.orderSeq = 1;
  }

  get tmpVec(): { x: number; y: number } { return this.tmp; }
}

export function humanStateLabel(s: HumanState): string {
  switch (s) {
    case 'MOVE': return '机动';
    case 'DEPLOY': return '展开';
    case 'HOLD': return '据守';
    case 'ENGAGE': return '交战';
    case 'RETREAT': return '后撤';
    case 'ROUT': return '溃退';
    case 'RECOVER': return '重整';
  }
}
