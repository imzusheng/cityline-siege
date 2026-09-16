// Animation contract shared by the simulation (which advances clocks) and the
// renderer (which resolves a clock into an atlas cell).

// There is no "death" clip: a fallen unit keeps its last pose for the 1.1 s the
// renderer still draws it, then becomes a corpse prop. Baking six death frames
// per facing spent a quarter of the atlas on something nothing ever plays — and
// a body lying flat is the widest pose of all, so those frames were also the
// worst offenders for drawing outside their cell.
export type AnimName = 'idle' | 'walk' | 'run' | 'aim' | 'shoot' | 'melee' | 'hit';

export const ANIM_ORDER: readonly AnimName[] = ['idle', 'walk', 'run', 'aim', 'shoot', 'melee', 'hit'];

export const ANIM_FRAMES: Record<AnimName, number> = {
  idle: 2, walk: 6, run: 4, aim: 2, shoot: 1, melee: 2, hit: 1,
};

// Every rate is 25 / n, so a clip holds each frame for a whole number of
// simulation ticks (SIM_HZ = 25). At 15 fps against a 25 Hz tick a run cycle
// alternates 40 ms and 80 ms holds, and that uneven rhythm reads as the whole
// horde juddering even though nothing is wrong with the animation itself.
export const ANIM_FPS: Record<AnimName, number> = {
  idle: 25 / 8,    // 3.125
  walk: 25 / 3,    // 8.33
  run: 25 / 2,     // 12.5
  aim: 25 / 13,    // 1.92
  shoot: 25 / 2,   // 12.5
  melee: 25 / 4,   // 6.25
  hit: 25 / 4,     // 6.25
};

/** looping animations */
export const ANIM_LOOP: Record<AnimName, boolean> = {
  idle: true, walk: true, run: true, aim: true, shoot: false, melee: false, hit: false,
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
  /** smoothed speed in units/s, kept by pickLocomotion */
  sp: number;
  /** seconds spent in the current locomotion clip */
  locoT: number;
}

export function makeAnimState(): AnimState { return { name: 'idle', t: 0, frame: 0, done: true, sp: 0, locoT: 0 }; }

export function setAnim(s: AnimState, name: AnimName, restart = true): void {
  if (s.name === name && !restart) return;
  s.name = name; s.t = 0; s.frame = 0; s.done = false;
}

/** Switch between locomotion clips without resetting the clock, so footfalls
 *  carry on across an idle/walk/run change instead of snapping to frame 0. */
export function setLoco(s: AnimState, name: AnimName): void {
  if (s.name === name) return;
  s.name = name;
  s.done = false;
  s.frame = Math.floor(s.t * ANIM_FPS[name]) % ANIM_FRAMES[name];
}

/** Clips a unit may fall back to when it is not shooting, aiming or striking. */
export function isLoco(name: AnimName): boolean {
  return name === 'idle' || name === 'walk' || name === 'run';
}

/** Seconds a locomotion clip must survive before the next one may take over. */
const LOCO_DWELL = 0.16;

/**
 * Locomotion clip for an instantaneous speed.
 *
 * The speed handed in is the displacement the movement solver actually achieved
 * this tick, and that is a terrible signal to threshold on: it collapses to zero
 * the moment a comrade blocks the step and jumps back to full speed the tick
 * after, so a soldier standing in a scrum crosses the walk and run boundaries
 * several times a second. Switching clips that fast restarts the animation from
 * frame 0 every time, which is what makes a line of soldiers look like it is
 * twitching. Smooth the speed, give each threshold a band to fall back through,
 * and refuse to change clip more often than LOCO_DWELL.
 */
export function pickLocomotion(s: AnimState, sp: number, dt: number, runOn: number, walkOn: number): AnimName {
  s.sp += (sp - s.sp) * Math.min(1, dt * 7);
  s.locoT += dt;
  const v = s.sp;
  const runOff = runOn * 0.62;
  const walkOff = walkOn * 0.45;
  let want: AnimName;
  if (s.name === 'run') want = v > runOff ? 'run' : v > walkOff ? 'walk' : 'idle';
  else if (s.name === 'walk') want = v > runOn ? 'run' : v > walkOff ? 'walk' : 'idle';
  else want = v > runOn ? 'run' : v > walkOn ? 'walk' : 'idle';
  if (want === s.name) return s.name;
  if (s.locoT < LOCO_DWELL && isLoco(s.name)) return s.name;
  s.locoT = 0;
  setLoco(s, want);
  return want;
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
