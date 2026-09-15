// Soldier and infected behaviour.
//
// Everything here is O(neighbours), never O(units^2): local queries go through
// the spatial hashes, the horde follows a shared flow field, and distant units
// think on a slower cadence while still integrating every tick.

import { clamp, faceTowards, lerp, TAU } from '../core/math';
import { HUMAN_STATS, MORALE, SIM_DT, ZOMBIE_STATS } from '../core/config';
import { advanceAnim, setAnim, type AnimName } from '../entities/anim';
import { canEngage, damageHuman, humanFire, zombieAttack, zombieHitBarricade, zombiePressure } from './combat';
import { advanceOrder, refitOrder, type LineOrder } from './orders';
import type { Human, World, Zombie } from './world';

const scratchA = { x: 0, y: 0 };
const scratchB = { x: 0, y: 0 };
const flowVec = { x: 0, y: 0 };

const ZOMBIE_STRIDE = [1, 2, 4];

// ------------------------------------------------------------------ steering

/** Move with wall sliding plus a cheap feeler search when the path is blocked. */
export function steer(world: World, u: { x: number; y: number; vx: number; vy: number }, dx: number, dy: number, speed: number, dt: number): number {
  const nav = world.nav;
  const l = Math.hypot(dx, dy);
  if (l < 1e-4) { u.vx *= 0.65; u.vy *= 0.65; return 0; }
  dx /= l; dy /= l;

  const look = 13 + speed * 0.16;
  let cx = dx, cy = dy;
  if (!nav.isOpenWorld(u.x + dx * look, u.y + dy * look)) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const off = (k % 2 === 0 ? 1 : -1) * (0.42 * (1 + (k >> 1)));
      const c = Math.cos(off), s = Math.sin(off);
      const ndx = dx * c - dy * s, ndy = dx * s + dy * c;
      if (nav.isOpenWorld(u.x + ndx * look, u.y + ndy * look) && nav.isOpenWorld(u.x + ndx * look * 0.45, u.y + ndy * look * 0.45)) {
        cx = ndx; cy = ndy; found = true; break;
      }
    }
    if (!found) { cx = 0; cy = 0; }
  }

  const step = speed * dt;
  const ox = u.x, oy = u.y;
  const nx = u.x + cx * step, ny = u.y + cy * step;
  if (nav.isOpenWorld(nx, ny)) { u.x = nx; u.y = ny; }
  else {
    if (nav.isOpenWorld(nx, u.y)) u.x = nx;
    if (nav.isOpenWorld(u.x, ny)) u.y = ny;
  }
  u.x = clamp(u.x, 6, 6394);
  u.y = clamp(u.y, 6, 4794);
  u.vx = (u.x - ox) / dt;
  u.vy = (u.y - oy) / dt;
  return Math.hypot(u.x - ox, u.y - oy) / Math.max(1e-5, step);
}

// -------------------------------------------------------------------- humans

export function tickHuman(world: World, h: Human, dt: number): void {
  if (!h.alive) { h.deadT += dt; advanceAnim(h.anim, dt); return; }
  const st = stOf(h);
  h.retarget -= dt;
  h.melee = Math.max(0, h.melee - dt);
  h.shotT = Math.max(0, h.shotT - dt);
  h.suppress = Math.max(0, h.suppress - dt);

  // ---------------------------------------------------------------- morale
  const press = zombiePressure(world, h.x, h.y, 108, scratchA);
  let friends = 0;
  world.hashH.forEachNear(h.x, h.y, 88, (i) => {
    const o = world.humans[i]!;
    if (o.alive && o !== h) friends++;
  });
  const threat = Math.max(0, press - friends * 0.6);
  if (threat > 0.4) h.morale -= (threat * 0.30 + Math.max(0, press - 6) * 0.16) * dt;
  else if (press === 0) h.morale += (friends > 2 ? MORALE.regenRecover : MORALE.regenPeace) * dt;
  if (world.state.time - h.lastHit < 4) h.morale -= dt * 1.5;
  if (h.cls === 'medic') {
    world.hashH.forEachNear(h.x, h.y, 30, (i) => {
      const o = world.humans[i]!;
      if (o.alive && o !== h && o.hp < o.maxHp) {
        o.hp = Math.min(o.maxHp, o.hp + dt * 7);
        o.morale = Math.min(100, o.morale + dt * 3.4);
      }
    });
  }
  h.morale = clamp(h.morale, 0, 100);

  // ------------------------------------------------------------- state machine
  if (h.state !== 'ROUT' && h.morale <= MORALE.rout) {
    h.state = 'ROUT';
    h.slotIndex = -1;
  } else if (h.state === 'ROUT') {
    if (h.morale >= MORALE.recover && press === 0) h.state = 'RECOVER';
  } else if (h.state === 'RECOVER') {
    if (press > 0 && h.morale < 58) h.state = 'DEPLOY';
    else if (h.morale > 76) h.state = 'DEPLOY';
  }

  // ---------------------------------------------------------------- aiming
  if (h.retarget <= 0) {
    h.retarget = 0.2 + world.rng.next() * 0.28;
    const range = st.range * (h.morale < 40 ? 0.72 : 1) * (h.state === 'ROUT' ? 0.5 : 1);
    let best: Zombie | null = null;
    let bd = range * range;
    world.hashZ.forEachNear(h.x, h.y, range, (i) => {
      const z = world.zombies[i];
      if (!z || !z.alive) return;
      if (!z.alive) return;
      const dx = z.x - h.x, dy = z.y - h.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = z; }
    });
    if (best && bd > 900 && !world.nav.losClear(h.x, h.y, (best as Zombie).x, (best as Zombie).y)) best = null;
    h.target = best;
  }

  let firing = false;
  const t = h.target;
  if (t && t.alive && h.state !== 'ROUT' && h.state !== 'RETREAT') {
    const dx = t.x - h.x, dy = t.y - h.y;
    const d = Math.hypot(dx, dy);
    if (d > st.range * 1.15) { h.target = null; h.aim *= 0.6; }
    else {
      faceTowards(h, dx, dy, dt);
      if (d < 11) h.melee = Math.max(h.melee, 0.3);
      firing = true;
      humanFire(world, h, t, dt);
      if (d < 40) {
        // never stand still inside a grapple: give ground, faster when shaken
        const back = h.morale < 45 ? 26 : 15;
        h.x -= h.faceX * dt * back;
        h.y -= h.faceY * dt * back;
      }
    }
  } else {
    h.aim = Math.max(0, h.aim - dt * 3);
  }

  // ---------------------------------------------------------------- movement
  const order = h.orderId ? world.orders.get(h.orderId) : undefined;
  let gx = h.orderX, gy = h.orderY;
  let speedMul = 1;
  let hold = false;

  if (h.state === 'ROUT') {
    // run away from the nearest infected, toward the nearest rally point
    let fx = 0, fy = 0, n = 0;
    world.hashZ.forEachNear(h.x, h.y, 150, (i) => {
      const z = world.zombies[i];
      if (!z || !z.alive) return;
      if (!z.alive) return;
      const dx = h.x - z.x, dy = h.y - z.y;
      const d = Math.hypot(dx, dy) || 1;
      fx += dx / d / d * 60; fy += dy / d / d * 60;
      n++;
    });
    const rally = nearestObjective(world, h.x, h.y);
    if (n < 2) { fx += (rally.x - h.x) * 0.01; fy += (rally.y - h.y) * 0.01; }
    gx = h.x + fx * 12;
    gy = h.y + fy * 12;
    speedMul = 1.32;
    h.slotIndex = -1;
  } else if (order) {
    if (h.slotIndex >= 0 && h.slotIndex < order.slots.length) {
      const s = order.slots[h.slotIndex]!;
      gx = s.x + s.jx; gy = s.y + s.jy;
    } else {
      const t2 = order.len > 24
        ? clamp(((h.x - order.ax) * order.dirX + (h.y - order.ay) * order.dirY) / order.len, 0, 1)
        : 0.5;
      gx = order.len > 24 ? order.ax + (order.bx - order.ax) * t2 : order.bx;
      gy = order.len > 24 ? order.ay + (order.by - order.ay) * t2 : order.by;
    }
    switch (order.kind) {
      case 'hold': speedMul = 1; break;
      case 'advance': speedMul = 0.95; break;
      case 'fallback': speedMul = 1.2; h.aim *= 0.4; break;
      case 'force': speedMul = 1.26; break;
      case 'move': speedMul = 1.22; break;
    }
    if (order.kind === 'hold' && Math.hypot(gx - h.x, gy - h.y) < 7) hold = true;
  } else {
    gx = h.x; gy = h.y;
    hold = true;
  }

  h.orderX = gx; h.orderY = gy;
  const gd = Math.hypot(gx - h.x, gy - h.y);
  let desiredX = 0, desiredY = 0;
  if (h.state === 'ENGAGE') speedMul *= 0.34;
  if (!hold && gd > 4) {
    desiredX = (gx - h.x) / gd;
    desiredY = (gy - h.y) / gd;
  } else if (firing && h.melee <= 0 && h.state === 'HOLD') {
    speedMul *= 0.2;
  }

  // separation from comrades — keeps the crowd organic instead of stacked
  const sepR = 9.5;
  let sx = 0, sy = 0, sn = 0;
  world.hashH.forEachNear(h.x, h.y, sepR, (i) => {
    if (sn >= 7) return;
    const o = world.humans[i]!;
    if (o === h || !o.alive) return;
    const ox = h.x - o.x, oy = h.y - o.y;
    const d2 = ox * ox + oy * oy;
    if (d2 > 1e-4 && d2 < sepR * sepR) {
      const d = Math.sqrt(d2);
      sx += (ox / d) * ((sepR - d) / sepR); sy += (oy / d) * ((sepR - d) / sepR);
      sn++;
    }
  });
  if (sn) { desiredX += sx * 0.85; desiredY += sy * 0.85; }

  const speed = h.speed * speedMul * (0.82 + 0.18 * (h.morale / 100));
  const moved = steer(world, h, desiredX, desiredY, speed, dt);
  if (moved < 0.15 && !hold) {
    h.stuck += dt;
    if (h.stuck > 0.7) {
      h.x += world.rng.jitter(6);
      h.y += world.rng.jitter(6);
      h.stuck = 0;
    }
  } else h.stuck = 0;

  // ---------------------------------------------------------------- facing
  if (!firing) {
    const sp = Math.hypot(h.vx, h.vy);
    if (sp > 6) faceTowards(h, h.vx, h.vy, dt);
    else if (order) faceTowards(h, order.frontX, order.frontY, dt);
  }

  // ---------------------------------------------------------------- animation
  const sp = Math.hypot(h.vx, h.vy);
  let want: AnimName;
  if (h.melee > 0 && h.target && h.alive) want = 'melee';
  else if (h.shotT > 0) want = 'shoot';
  else if (firing) want = 'aim';
  else if (sp > 27) want = 'run';
  else if (sp > 3.5) want = 'walk';
  else want = 'idle';
  advanceState(h.anim, want, dt);
}

function advanceState(anim: Human['anim'], want: AnimName, dt: number): void {
  const transient = anim.name === 'shoot' || anim.name === 'melee' || anim.name === 'hit';
  if (transient && !anim.done) { advanceAnim(anim, dt); return; }
  if (anim.name !== want) setAnim(anim, want, true);
  advanceAnim(anim, dt);
}

function nearestObjective(world: World, x: number, y: number): { x: number; y: number } {
  let best = world.city.objectives[0]!;
  let bd = 1e18;
  for (const o of world.city.objectives) {
    const d = (o.x - x) ** 2 + (o.y - y) ** 2;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function stOf(h: Human) { return HUMAN_STATS[h.cls]; }


// ------------------------------------------------------------------- zombies

export function tickZombie(world: World, z: Zombie, dt: number, tick: number): void {
  if (!z.alive) { z.deadT += dt; advanceAnim(z.anim, dt); return; }
  z.hitFlash = Math.max(0, z.hitFlash - dt);
  z.aiTick -= dt;
  if (z.aiTick <= 0) {
    const stride = ZOMBIE_STRIDE[z.lod] ?? 2;
    z.aiTick = SIM_DT * stride * (0.85 + world.rng.next() * 0.3);
    zombieThink(world, z);
  }
  zombieMove(world, z, dt);
  void tick;
}

function zombieThink(world: World, z: Zombie): void {
  const st = ZOMBIE_STATS[z.cls];
  z.retarget -= SIM_DT * 2;
  if (z.retarget <= 0) {
    z.retarget = 0.35 + world.rng.next() * 0.5;
    const sense = z.cls === 'runner' ? 250 : z.cls === 'brute' ? 175 : 195;
    const h = world.nearestHuman(z.x, z.y, sense);
    if (h && world.nav.losClear(z.x, z.y, h.x, h.y)) z.target = h;
    else if (h && Math.hypot(h.x - z.x, h.y - z.y) < 70) z.target = h;
    else z.target = null;
  }

  let dx = 0, dy = 0;
  if (z.target && z.target.alive) {
    const d = Math.hypot(z.target.x - z.x, z.target.y - z.y);
    if (d < st.reach + 4) {
      z.state = 'ATTACK';
      z.dx = 0; z.dy = 0;
      z.pressure *= 0.5;
      return;
    }
    z.state = 'CHASE';
    dx = (z.target.x - z.x) / (d || 1);
    dy = (z.target.y - z.y) / (d || 1);
  } else {
    z.target = null;
    z.state = 'FLOW';
    world.nav.sampleFlow(z.x, z.y, flowVec);
    dx = flowVec.x; dy = flowVec.y;
    if (dx === 0 && dy === 0) {
      const a = Math.atan2(2400 - z.y, 3200 - z.x) + (z.seed - 0.5) * 1.4;
      dx = Math.cos(a); dy = Math.sin(a);
    }
  }

  // crowd: separation + a little alignment so streams stay coherent
  const sep = ZOMBIE_STATS[z.cls].radius * (1.6 + z.pressure * 0.7);
  const sep2 = sep * sep;
  let sx = 0, sy = 0, ax = 0, ay = 0, n = 0;
  world.hashZ.forEachNear(z.x, z.y, sep, (i) => {
    if (n >= 9) return;
    const o = world.zombies[i]!;
    if (o === z || !o.alive) return;
    const ox = z.x - o.x, oy = z.y - o.y;
    const d2 = ox * ox + oy * oy;
    if (d2 > 1e-4 && d2 < sep2) {
      const d = Math.sqrt(d2);
      const w = (sep - d) / sep;
      sx += (ox / d) * w; sy += (oy / d) * w;
      ax += o.dx * w; ay += o.dy * w;
      n++;
    }
  });
  if (n) {
    const w = 1.5 + z.pressure * 1.1;
    dx += sx * w; dy += sy * w;
    dx += ax * 0.22; dy += ay * 0.22;
  }
  const l = Math.hypot(dx, dy);
  if (l > 1e-4) { z.dx = dx / l; z.dy = dy / l; }
}

function zombieMove(world: World, z: Zombie, dt: number): void {
  const st = ZOMBIE_STATS[z.cls];
  if (z.state === 'ATTACK') {
    const t = z.target;
    if (t && t.alive) {
      const d = Math.hypot(t.x - z.x, t.y - z.y);
      if (d > st.reach + 6) { z.state = 'CHASE'; }
      else {
        zombieAttack(world, z, t, dt);
        advanceState(z.anim, z.anim.name === 'melee' && !z.anim.done ? 'melee' : 'idle', dt);
        z.faceX = (t.x - z.x) / (d || 1);
        z.faceY = (t.y - z.y) / (d || 1);
        return;
      }
    } else { z.target = null; z.state = 'FLOW'; }
  }
  if (z.state === 'BREACH' && zombieHitBarricade(world, z, dt)) {
    advanceState(z.anim, z.anim.name === 'melee' && !z.anim.done ? 'melee' : 'idle', dt);
    return;
  }

  const stagger = z.stagger > 0 ? 0.35 : 1;
  z.stagger = Math.max(0, z.stagger - dt);
  const speed = z.speed * stagger * (z.state === 'CHASE' ? 1.06 : 0.92);
  const before = { x: z.x, y: z.y };
  steer(world, z, z.dx, z.dy, speed, dt);
  const stepLen = Math.hypot(z.x - before.x, z.y - before.y);
  const want = speed * dt;
  if (want > 1e-4) {
    const ratio = stepLen / want;
    if (ratio < 0.4) {
      z.pressure = Math.min(1.6, z.pressure + dt * 1.4);
      if (z.pressure > 1.0 && world.rng.chance(0.06)) {
        // try to squeeze past: nudge sideways
        const a = Math.atan2(z.dy, z.dx) + (world.rng.chance(0.5) ? 1 : -1) * 1.1;
        z.dx = Math.cos(a); z.dy = Math.sin(a);
      }
      if (z.pressure > 0.7 && zombieHitBarricade(world, z, dt)) {
        advanceState(z.anim, z.anim.name === 'melee' && !z.anim.done ? 'melee' : 'idle', dt);
        return;
      }
    } else {
      z.pressure = Math.max(0, z.pressure - dt * 1.1);
    }
  }

  const sp = Math.hypot(z.vx, z.vy);
  if (sp > 3) {
    const k = 0.16;
    z.faceX = lerp(z.faceX, z.vx / sp, k);
    z.faceY = lerp(z.faceY, z.vy / sp, k);
    const fl = Math.hypot(z.faceX, z.faceY) || 1;
    z.faceX /= fl; z.faceY /= fl;
  }
  let want2: AnimName;
  if (sp > st.speed * 0.72) want2 = 'run';
  else if (sp > 1.6) want2 = 'walk';
  else want2 = 'idle';
  advanceState(z.anim, want2, dt);
}

// ------------------------------------------------------------------- orders

export function tickOrders(world: World, dt: number): void {
  for (const order of world.orders.values()) {
    if (!order.active) continue;
    let contact = false;
    if (order.kind === 'advance') {
      world.hashZ.forEachNear((order.ax + order.bx) / 2, (order.ay + order.by) / 2, 260, (i) => {
        const z = world.zombies[i];
      if (!z || !z.alive) return;
        if (z.alive) contact = true;
      });
    }
    advanceOrder(order, dt, contact);
    refitOrder(world, order, dt);

  }
  // retire orders whose troops are all gone
  for (const [id, order] of world.orders) {
    let n = 0;
    for (const h of world.humans) if (h.alive && h.orderId === id) { n++; break; }
    if (!n) { order.active = false; world.orders.delete(id); }
  }
}

export { damageHuman, canEngage, TAU };
