// Animation contract shared by the simulation (which advances clocks) and the
// renderer (which resolves a clock into an atlas cell).

export type AnimName = 'idle' | 'walk' | 'run' | 'aim' | 'shoot' | 'melee' | 'hit' | 'death';

export const ANIM_ORDER: readonly AnimName[] = ['idle', 'walk', 'run', 'aim', 'shoot', 'melee', 'hit', 'death'];

export const ANIM_FRAMES: Record<AnimName, number> = {
  idle: 2, walk: 6, run: 4, aim: 2, shoot: 1, melee: 2, hit: 1, death: 6,
};

export const ANIM_FPS: Record<AnimName, number> = {
  idle: 3.4, walk: 8.5, run: 15, aim: 2.0, shoot: 13, melee: 7, hit: 6, death: 8.5,
};

/** looping animations */
export const ANIM_LOOP: Record<AnimName, boolean> = {
  idle: true, walk: true, run: true, aim: true, shoot: false, melee: false, hit: false, death: false,
};

export const TOTAL_FRAMES = ANIM_ORDER.reduce((a, n) => a + ANIM_FRAMES[n], 0);

/** The five hand-authored directions; the other three come from mirroring. */
export const DIR_BASE_ANGLE = [0, 45, 90, 270, 315] as const;
export const DIR_BASE = DIR_BASE_ANGLE.length;
export const DIR_COUNT = 8;
/** bucket -> base direction index */
export const DIR_TO_BASE = [0, 1, 2, 1, 0, 4, 3, 4] as const;
/** bucket -> mirrored horizontally */
export const DIR_MIRROR = [false, false, false, true, true, true, false, false] as const;

/** Offset of (anim, frame) inside a type's 26-frame block. */
export const ANIM_OFFSET: Record<AnimName, number> = (() => {
  const out = {} as Record<AnimName, number>;
  let acc = 0;
  for (const n of ANIM_ORDER) { out[n] = acc; acc += ANIM_FRAMES[n]; }
  return out;
})();

export function animFrameIndex(anim: AnimName, frame: number): number {
  const n = ANIM_FRAMES[anim];
  const f = ANIM_LOOP[anim] ? ((frame % n) + n) % n : Math.min(frame, n - 1);
  return ANIM_OFFSET[anim] + f;
}

/** Degrees the facing may drift from the held bucket before the sprite swaps. */
const DIR_HOLD_DEG = 30;

/**
 * Screen-space facing angle (unpitched) -> direction bucket 0..7.
 *
 * `prev` is the bucket currently in use, or -1 when unset. Rounding the angle
 * straight to the nearest 45 degrees makes the sprite flip between two
 * neighbouring directions whenever the facing sits near a bucket edge — measured
 * at up to 19 flips per second on a soldier tracking a jittering target, which
 * reads as the model twitching. Holding the current bucket until the angle is
 * well past the boundary removes that without making the turn feel late.
 */
export function dirBucket(phi: number, prev = -1): number {
  let a = phi * (180 / Math.PI);
  a = ((a % 360) + 360) % 360;
  const raw = Math.round(a / 45) % 8;
  if (prev < 0) return raw;
  let d = a - prev * 45;
  d = ((d % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return Math.abs(d) <= DIR_HOLD_DEG ? prev : raw;
}

export interface AnimState {
  name: AnimName;
  t: number;
  frame: number;
  /** set when a one-shot animation finishes */
  done: boolean;
}

export function makeAnimState(): AnimState { return { name: 'idle', t: 0, frame: 0, done: true }; }

export function setAnim(s: AnimState, name: AnimName, restart = true): void {
  if (s.name === name && !restart) return;
  s.name = name; s.t = 0; s.frame = 0; s.done = false;
}

export function advanceAnim(s: AnimState, dt: number): void {
  if (s.done) return;
  s.t += dt;
  const fps = ANIM_FPS[s.name];
  const n = ANIM_FRAMES[s.name];
  if (ANIM_LOOP[s.name]) {
    s.frame = Math.floor(s.t * fps) % n;
  } else {
    s.frame = Math.floor(s.t * fps);
    if (s.frame >= n) { s.frame = n - 1; s.done = true; }
  }
}

/** phase in [0,1) for procedural pose generation */
export function animPhase(s: AnimState): number {
  const n = ANIM_FRAMES[s.name];
  return (s.frame + 0.5) / n;
}
