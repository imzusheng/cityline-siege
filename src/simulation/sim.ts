// Fixed-step simulation entry point.

import { SIM_DT } from '../core/config';
import { advanceAnim } from '../entities/anim';
import { tickHuman, tickOrders, tickZombie } from './ai';
import { checkEndConditions, makeDirectorState, updateDirector, updateObjectives, type DirectorHooks, type DirectorState } from './director';
import type { World } from './world';
import { issueOrder } from './orders';

export class Simulation {
  world: World;
  director: DirectorState = makeDirectorState();
  hooks: DirectorHooks;
  private lodClock = 0;
  private flowDirty = true;
  onEnd: ((result: 'win' | 'lose') => void) | null = null;

  constructor(world: World, hooks: DirectorHooks) {
    this.world = world;
    this.hooks = hooks;
  }

  reset(): void {
    this.director = makeDirectorState();
    this.flowDirty = true;
    this.rebuildFlow();
  }

  rebuildFlow(): void {
    const { city, nav } = this.world;
    nav.buildFlow(city.objectives.filter(o => !o.lost), 0.16);
    this.flowDirty = false;
  }

  step(dt: number): void {
    const w = this.world;
    if (w.state.paused || w.state.ended) return;
    w.state.time += dt;
    w.state.shake = Math.max(0, w.state.shake - dt * 2.2);
    w.rebuildHashes();
    w.aliveCounts();

    updateDirector(w, this.director, dt, this.hooks);
    this.updateLod(dt);
    tickOrders(w, dt);
    this.tickEffects(dt);

    const humans = w.humans;
    for (let i = 0; i < humans.length; i++) tickHuman(w, humans[i]!, dt);
    const zombies = w.zombies;
    for (let i = 0; i < zombies.length; i++) tickZombie(w, zombies[i]!, dt, i);

    updateObjectives(w, dt);
    w.nav.decayHeat(dt);
    if (w.state.time % 1 < dt) w.compact();

    const result = checkEndConditions(w);
    if (result) {
      w.state.ended = true;
      this.onEnd?.(result);
    }
  }

  private updateLod(dt: number): void {
    this.lodClock -= dt;
    if (this.lodClock > 0) return;
    this.lodClock = 0.35;
    const w = this.world;
    const fx = w.focusX, fy = w.focusY;
    for (const z of w.zombies) {
      if (!z.alive) continue;
      const d2 = (z.x - fx) ** 2 + (z.y - fy) ** 2;
      z.lod = d2 < 1100 * 1100 ? 0 : d2 < 2400 * 2400 ? 1 : 2;
    }
  }

  private tickEffects(dt: number): void {
    const eff = this.world.effects;
    for (let i = eff.length - 1; i >= 0; i--) {
      const e = eff[i]!;
      e.t -= dt;
      if (e.t <= 0) {
        eff[i] = eff[eff.length - 1]!;
        eff.pop();
      }
    }
    if (eff.length > 1800) eff.splice(0, eff.length - 1800);
  }

  issue(kind: Parameters<typeof issueOrder>[2], units: Parameters<typeof issueOrder>[1], ax: number, ay: number, bx: number, by: number) {
    return issueOrder(this.world, units, kind, ax, ay, bx, by);
  }
}

export { SIM_DT };
