// Combat resolution: shooting, melee contact, damage and the feedback effects
// that make a firefight readable from three zoom levels away.

import { clamp, faceTowards, TAU } from '../core/math';
import { HUMAN_STATS, ZOMBIE_STATS } from '../core/config';
import { FX, type Human, type World, type Zombie } from './world';

/** Cone/range test used before a soldier commits to a target. */
export function canEngage(world: World, h: Human, z: Zombie, range: number): boolean {
  const dx = z.x - h.x, dy = z.y - h.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > range * range) return false;
  if (d2 < 400) return true;
  return world.nav.losClear(h.x, h.y, z.x, z.y);
}

export function humanFire(world: World, h: Human, z: Zombie, dt: number): void {
  const st = HUMAN_STATS[h.cls];
  h.cool -= dt;
  // aim build-up, longer when panicked or moving
  const moving = Math.hypot(h.vx, h.vy) > 9;
  const aimRate = (moving ? 5.2 : 9.5) * (0.5 + 0.5 * h.morale / 100);
  h.aim = Math.min(1, h.aim + dt * aimRate);
  if (h.cool > 0 || h.aim < 1) return;

  const dx = z.x - h.x, dy = z.y - h.y;
  const dist = Math.hypot(dx, dy) || 1;
  faceTowards(h, dx, dy, dt);
  const burst = h.cls === 'gunner' ? 3 : 1;
  h.cool = st.cooldown;

  const moraleF = 0.5 + 0.5 * (h.morale / 100);
  const distF = 1 - clamp(dist / st.range, 0, 1) * 0.5;
  const moveF = moving ? 0.66 : 1;
  const meleeF = h.melee > 0 ? 0.55 : 1;
  const acc = clamp(st.accuracy * moraleF * distF * moveF * meleeF, 0.05, 0.97);

  h.shotT = h.cls === 'gunner' ? 0.07 : 0.1;
  h.shotX = z.x; h.shotY = z.y;
  world.addEffect(FX.FLASH, h.x + h.faceX * 6, h.y + h.faceY * 6, 0, 0, 0.055, 9, 1, 0.86, 0.55, 1);
  if (st.suppress > 0) {
    world.affectMorale(h.x, h.y, st.suppress + 40, -0.4);
  }

  for (let b = 0; b < burst; b++) {
    if (world.rng.next() > acc) {
      // miss: kick up dust near the target
      if (world.rng.chance(0.35)) {
        world.addEffect(FX.DUST, z.x + world.rng.jitter(9), z.y + world.rng.jitter(9), 0, 0, 0.3, 6, 0.55, 0.53, 0.48, 0.45);
      }
      continue;
    }
    const spread = st.spread * (moving ? 1.7 : 1) * (h.melee > 0 ? 1.5 : 1);
    const dmg = (st.dmgMin + (st.dmgMax - st.dmgMin) * world.rng.next()) * (0.75 + 0.25 * moraleF);
    void spread;
    damageZombie(world, z, dmg, h);
    if (!z.alive) break;
  }
}

export function damageZombie(world: World, z: Zombie, amount: number, _from?: Human): void {
  z.hp -= amount;
  z.hitFlash = 0.12;
  if (z.hp <= 0) world.killZombie(z);
}

export function damageHuman(world: World, h: Human, amount: number, from?: Zombie): void {
  if (!h.alive) return;
  h.hp -= amount;
  h.lastHit = world.state.time;
  h.morale = Math.max(0, h.morale - amount * 0.25);
  h.anim.name = 'hit';
  h.anim.t = 0; h.anim.frame = 0; h.anim.done = false;
  world.addEffect(FX.BLOOD, h.x, h.y, 0, 0, 0.4, 11, 0.42, 0.16, 0.14, 0.7);
  if (h.hp <= 0) world.killHuman(h, from);
}

export function zombieAttack(world: World, z: Zombie, h: Human, dt: number): void {
  const st = ZOMBIE_STATS[z.cls];
  z.cool -= dt;
  const dx = h.x - z.x, dy = h.y - z.y;
  faceTowards(z, dx, dy, dt);
  if (z.cool > 0) return;
  z.cool = st.attackRate * (0.8 + world.rng.next() * 0.5);
  z.anim.name = 'melee'; z.anim.t = 0; z.anim.frame = 0; z.anim.done = false;
  const dmg = st.dmg * (0.75 + world.rng.next() * 0.55);
  damageHuman(world, h, dmg, z);
  if (h.alive) {
    // shove the soldier back so the front line churns
    world.nav.slideMove(h, z.faceX * 2.2, z.faceY * 2.2);
    if (world.rng.chance(0.35)) world.addEffect(FX.SPARK, h.x, h.y, 0, 0, 0.2, 7, 0.9, 0.85, 0.7, 0.5);
  }
  if (z.cls === 'brute') world.state.shake = Math.min(1, world.state.shake + 0.25);
}

export function zombieHitBarricade(world: World, z: Zombie, dt: number): boolean {
  const b = nearestBarricade(world, z.x, z.y, 15);
  if (!b) return false;
  z.cool -= dt;
  z.state = 'BREACH';
  if (z.cool > 0) return true;
  const st = ZOMBIE_STATS[z.cls];
  z.cool = st.attackRate * 1.3;
  z.anim.name = 'melee'; z.anim.t = 0; z.anim.frame = 0; z.anim.done = false;
  b.hp -= st.dmg * 3.2;
  world.addEffect(FX.DUST, b.x, b.y, 0, 0, 0.35, 10, 0.6, 0.56, 0.46, 0.5);
  if (b.hp <= 0 && b.alive) {
    b.alive = false;
    world.nav.blocked[b.cellY * world.nav.w + b.cellX] = 0;
    world.addEffect(FX.DUST, b.x, b.y, 0, 0, 0.8, 30, 0.65, 0.6, 0.5, 0.55);
    world.state.shake = Math.min(1, world.state.shake + 0.2);
  }
  return true;
}

export interface BarricadeRef { x: number; y: number; hp: number; alive: boolean; cellX: number; cellY: number }

function nearestBarricade(world: World, x: number, y: number, r: number): BarricadeRef | null {
  let best: BarricadeRef | null = null;
  let bd = r * r;
  for (const b of world.city.barricades) {
    if (!b.alive) continue;
    const dx = b.x - x, dy = b.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = b; }
  }
  return best;
}

/** Local zombie density, used for morale and for the suppression model. */
export function zombiePressure(world: World, x: number, y: number, radius: number, scratch: { x: number; y: number }): number {
  let n = 0;
  const r2 = radius * radius;
  world.hashZ.forEachNear(x, y, radius, (i) => {
    if (n >= 26) return;
    const z = world.zombies[i];
      if (!z || !z.alive) return;
    if (!z.alive) return;
    const dx = z.x - x, dy = z.y - y;
    if (dx * dx + dy * dy < r2) n++;
  });
  scratch.x = n;
  return n;
}

/** Ray-cast a straight corridor for the flow field debug / breach logic. */
export function corridorClear(world: World, x: number, y: number, ang: number, len: number): boolean {
  const steps = Math.ceil(len / 12);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!world.nav.isOpenWorld(x + Math.cos(ang) * len * t, y + Math.sin(ang) * len * t)) return false;
  }
  return true;
}

export { TAU };
