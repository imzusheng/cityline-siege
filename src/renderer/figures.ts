// Miniature-figure renderer.
//
// A figure is posed as a small 3D skeleton in body space (x = forward, y = right,
// z = up) and projected with the *same* axonometric transform the game camera
// uses. Because the projection happens at bake time we get consistent 3/4 views
// for every facing, real volume, and correct limb occlusion for free.
//
// The atlas cell is 136x136 with the feet anchored at (68, 94). A sprite quad
// maps exactly one cell, so a pose that crosses the border is visibly sliced
// off, and the bounds are set by the rifle: an axonometric view projects a
// weapon held forward far to the side (65 px) and, facing "south", far above the
// head (88 px). Measured over every frame of every type and facing, the worst
// case is 63 px right, 35 px left, 88 px up and 21 px down, which leaves a few
// pixels of margin on each edge.

import { TAU, clamp, lerp } from '../core/math';
import { PITCH, ZSCALE } from '../core/config';
import type { AnimName } from '../entities/anim';

export const CELL = 136;
export const CHAR_H = 60;
export const BP = CHAR_H / ZSCALE; // px per body-unit of ground extent
export const FEET_ROW = 94;

export interface V3 { x: number; y: number; z: number }
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => { const l = len(a) || 1; return mul(a, 1 / l); };
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** rotate about body Y (right axis) — leg/arm swing fore/aft */
function rotY(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}
function rotZ(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z };
}
function rotX(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x, y: p.y * c + p.z * s, z: -p.y * s + p.z * c };
}
/** Rodrigues rotation about an arbitrary unit axis. */
function rotAxis(p: V3, axis: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  const k = dot(axis, p);
  const cr = cross(axis, p);
  return {
    x: p.x * c + cr.x * s + axis.x * k * (1 - c),
    y: p.y * c + cr.y * s + axis.y * k * (1 - c),
    z: p.z * c + cr.z * s + axis.z * k * (1 - c),
  };
}

export interface FigureColors {
  skin: string; skinShade: string; hair: string;
  torso: string; torsoShade: string; legs: string; legsShade: string;
  boots: string; gear: string; weapon: string; weaponDark: string;
  accent: string; outline: string;
}

export type Headgear = 'helmet' | 'cap' | 'beret' | 'med' | 'none';
export type WeaponKind = 'rifle' | 'lmg' | 'shotgun' | 'pistol' | 'none';

export interface FigureSpec {
  id: string;
  kind: 'human' | 'zombie';
  build: number;
  height: number;
  headR: number;
  shoulderHalf: number;
  colors: FigureColors;
  headgear: Headgear;
  weapon: WeaponKind;
  backpack: number;
  hunch: number;
  shamble: number;
  belt: boolean;
  armband?: string;
  bulky?: number;
}

export interface Pose {
  hipL: number; kneeL: number; liftL: number;
  hipR: number; kneeR: number; liftR: number;
  handR: V3; weaponYaw: number; weaponPitch: number;
  /** explicit support-hand target; when unset it is derived from the weapon */
  handL?: V3;
  torsoLean: number; torsoTwist: number;
  headTilt: number; headYaw: number;
  crouch: number; bob: number;
  fall: number; fallAxis: number;
  shiftX: number; shiftY: number;
  armsOut: number;
  scale: number;
  noWeapon?: boolean;
}

// ------------------------------------------------------------------ skeleton

const HIP_Z = 0.500, SHOULDER_Z = 0.792, NECK_Z = 0.845, HEAD_Z = 0.918;
const THIGH = 0.235, SHIN = 0.225;
const UPPER_ARM = 0.180, FOREARM = 0.175;

export interface Joints {
  hip: V3; pelvis: V3; chest: V3; neck: V3;
  hipL: V3; kneeL: V3; ankleL: V3; toeL: V3;
  hipR: V3; kneeR: V3; ankleR: V3; toeR: V3;
  shoL: V3; shoR: V3; elbowL: V3; elbowR: V3;
  handL: V3; handR: V3; head: V3;
}

function solveIK(root: V3, target: V3, l1: number, l2: number, bendHint: V3): V3 {
  const d = sub(target, root);
  let dl = len(d);
  const maxD = (l1 + l2) * 0.999;
  const minD = Math.abs(l1 - l2) * 1.01 + 1e-4;
  const dir = dl < 1e-5 ? v3(1, 0, 0) : mul(d, 1 / dl);
  dl = clamp(dl, minD, maxD);
  const a = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let b = sub(bendHint, mul(dir, dot(bendHint, dir)));
  const bl = len(b);
  b = bl < 1e-4 ? v3(0, 1, 0) : mul(b, 1 / bl);
  return add(add(root, mul(dir, a)), mul(b, h));
}

function legChain(side: number, hipA: number, kneeA: number, lift: number, hipZ: number, hipHalfY: number, spec: FigureSpec): { hip: V3; knee: V3; ankle: V3; toe: V3 } {
  const hip = v3(0, side * hipHalfY, hipZ + lift * 0.06);
  const tdir = rotY(v3(0, 0, -1), hipA);
  const knee = add(hip, mul(tdir, THIGH));
  const sdir = rotY(v3(0, 0, -1), hipA + kneeA);
  const ankle = add(knee, mul(sdir, SHIN));
  const toe = add(ankle, rotY(v3(0.055, 0, -0.035), hipA + kneeA * 0.4));
  return { hip, knee, ankle, toe };
}

function buildJoints(spec: FigureSpec, p: Pose): Joints {
  const build = spec.build;
  const hipHalfY = 0.055 * build;
  const shoulderHalf = spec.shoulderHalf;
  const hipZ = HIP_Z - p.crouch * 0.15;
  const hipHalfScaled = hipHalfY;

  const L = legChain(1, p.hipL, p.kneeL, p.liftL, hipZ, hipHalfScaled, spec);
  const R = legChain(-1, p.hipR, p.kneeR, p.liftR, hipZ, hipHalfScaled, spec);

  const pelvis = v3(0, 0, hipZ);
  const chestBase = v3(0, 0, SHOULDER_Z - p.crouch * 0.13);
  let chest = rotY(sub(chestBase, pelvis), p.torsoLean);
  chest = rotZ(chest, p.torsoTwist);
  chest = add(chest, pelvis);
  let neck = rotY(sub(v3(0, 0, NECK_Z - p.crouch * 0.13), pelvis), p.torsoLean);
  neck = rotZ(neck, p.torsoTwist);
  neck = add(neck, pelvis);

  const shoL = add(chest, rotZ(rotY(v3(0, shoulderHalf, 0), p.torsoLean), p.torsoTwist));
  const shoR = add(chest, rotZ(rotY(v3(0, -shoulderHalf, 0), p.torsoLean), p.torsoTwist));

  let head = rotY(sub(v3(0, 0, HEAD_Z - p.crouch * 0.13), pelvis), p.torsoLean);
  head = rotZ(head, p.torsoTwist);
  head = add(head, pelvis);
  head = rotAxis(head, v3(0, 1, 0), p.headTilt);
  head = rotAxis(head, v3(0, 0, 1), p.headYaw);

  const handR = p.handR;
  const weaponDir = norm(rotZ(rotY(v3(1, 0, 0), p.weaponPitch), p.weaponYaw));
  const handL = p.handL ?? add(handR, mul(weaponDir, 0.255));

  const bendR = norm(add(v3(0.2, 0.9, -1.1), v3(0, 0, p.armsOut * 0.2)));
  const elbowR = solveIK(shoR, handR, UPPER_ARM, FOREARM, bendR);
  const bendL = norm(add(v3(0.4, -0.7, -1.3), v3(0, 0, p.armsOut * 0.2)));
  const elbowL = solveIK(shoL, handL, UPPER_ARM, FOREARM, bendL);

  const tf = (q: V3): V3 => {
    let r = rotAxis(q, v3(Math.cos(p.fallAxis), Math.sin(p.fallAxis), 0), p.fall);
    r = add(r, v3(p.shiftX, p.shiftY, p.bob));
    return r;
  };
  return {
    hip: tf(pelvis), pelvis: tf(pelvis), chest: tf(chest), neck: tf(neck),
    hipL: tf(L.hip), kneeL: tf(L.knee), ankleL: tf(L.ankle), toeL: tf(L.toe),
    hipR: tf(R.hip), kneeR: tf(R.knee), ankleR: tf(R.ankle), toeR: tf(R.toe),
    shoL: tf(shoL), shoR: tf(shoR), elbowL: tf(elbowL), elbowR: tf(elbowR),
    handL: tf(handL), handR: tf(handR), head: tf(head),
  };
}

// ---------------------------------------------------------------- projection

interface Proj { c: number; s: number; }

function proj(q: V3, pr: Proj): { x: number; y: number } {
  const gx = q.x * pr.c - q.y * pr.s;
  const gy = (q.x * pr.s + q.y * pr.c) * PITCH;
  return { x: gx * BP, y: gy * BP - q.z * CHAR_H };
}
function depthOf(q: V3, pr: Proj): number {
  return (q.x * pr.s + q.y * pr.c) * PITCH + q.z * ZSCALE;
}

// ------------------------------------------------------------------ painting

type Ctx = CanvasRenderingContext2D;
type Pt = { x: number; y: number };
type Fill = string | CanvasGradient;

/** The bake lights every figure from the upper left, matching the baked drop
 *  shadow and the ground texture's own lighting. */
const LIGHT_X = -0.707, LIGHT_Y = -0.707;

function hexRgb(h: string): [number, number, number] {
  if (h[0] !== '#') return [128, 128, 128];
  const v = h.length > 4
    ? [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
    : [parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16), parseInt(h[3]! + h[3]!, 16)];
  return [v[0] ?? 128, v[1] ?? 128, v[2] ?? 128];
}
function mixc(a: string, b: string, t: number): string {
  const ca = hexRgb(a), cb = hexRgb(b);
  return `rgb(${Math.round(lerp(ca[0], cb[0], t))},${Math.round(lerp(ca[1], cb[1], t))},${Math.round(lerp(ca[2], cb[2], t))})`;
}
/** Positive lightens toward white, negative darkens. */
function tone(c: string, k: number): string {
  return k >= 0 ? mixc(c, '#ffffff', k) : mixc(c, '#0b0d0c', -k);
}

function poly(ctx: Ctx, pts: Pt[], fill: Fill, outline: string, lw: number): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (lw > 0) { ctx.lineWidth = lw; ctx.strokeStyle = outline; ctx.stroke(); }
}

/** Flat limb, used for the prone corpses where volume does not read anyway. */
function limb(ctx: Ctx, a: Pt, b: Pt, wa: number, wb: number, fill: Fill, outline: string, lw: number): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l;
  poly(ctx, [
    { x: a.x + nx * wa * 0.5, y: a.y + ny * wa * 0.5 },
    { x: b.x + nx * wb * 0.5, y: b.y + ny * wb * 0.5 },
    { x: b.x - nx * wb * 0.5, y: b.y - ny * wb * 0.5 },
    { x: a.x - nx * wa * 0.5, y: a.y - ny * wa * 0.5 },
  ], fill, outline, lw);
  ctx.beginPath(); ctx.arc(b.x, b.y, wb * 0.5, 0, TAU); ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath(); ctx.arc(a.x, a.y, wa * 0.5, 0, TAU); ctx.fillStyle = fill; ctx.fill();
  if (lw > 0) {
    ctx.lineWidth = lw; ctx.strokeStyle = outline;
    ctx.beginPath(); ctx.arc(a.x, a.y, wa * 0.5, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(b.x, b.y, wb * 0.5, 0, TAU); ctx.stroke();
  }
}

/**
 * Tapered limb segment with a cylindrical gradient. The cross-limb gradient axis
 * is flipped when needed so the lit side always faces up-left, whatever the limb
 * is doing — otherwise a swinging arm would light itself from the wrong side
 * halfway through the walk cycle.
 */
function tube(ctx: Ctx, a: Pt, b: Pt, wa: number, wb: number, base: string, outline: string, lw: number): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  let nx = -dy / l, ny = dx / l;
  if (nx * LIGHT_X + ny * LIGHT_Y < 0) { nx = -nx; ny = -ny; }
  const w = Math.max(wa, wb);
  const g = ctx.createLinearGradient(a.x + nx * w * 0.5, a.y + ny * w * 0.5, a.x - nx * w * 0.5, a.y - ny * w * 0.5);
  g.addColorStop(0, tone(base, 0.30));
  g.addColorStop(0.45, base);
  g.addColorStop(1, tone(base, -0.28));
  poly(ctx, [
    { x: a.x + nx * wa * 0.5, y: a.y + ny * wa * 0.5 },
    { x: b.x + nx * wb * 0.5, y: b.y + ny * wb * 0.5 },
    { x: b.x - nx * wb * 0.5, y: b.y - ny * wb * 0.5 },
    { x: a.x - nx * wa * 0.5, y: a.y - ny * wa * 0.5 },
  ], g, outline, lw);
  joint(ctx, b, wb * 0.5, base, outline, lw * 0.8);
  joint(ctx, a, wa * 0.5, base, outline, lw * 0.8);
}

/** Rounded cap for a joint, shaded as a sphere so elbows and knees read round. */
function joint(ctx: Ctx, c: Pt, r: number, base: string, outline: string, lw: number): void {
  const g = ctx.createRadialGradient(c.x + LIGHT_X * r * 0.45, c.y + LIGHT_Y * r * 0.45, r * 0.12, c.x, c.y, r * 1.05);
  g.addColorStop(0, tone(base, 0.34));
  g.addColorStop(0.65, base);
  g.addColorStop(1, tone(base, -0.26));
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU);
  ctx.fillStyle = g; ctx.fill();
  if (lw > 0) { ctx.lineWidth = lw; ctx.strokeStyle = outline; ctx.stroke(); }
}

/** Flat-ish panel (torso, vest, pouch) shaded across its own width. */
function plate(ctx: Ctx, pts: Pt[], base: string, outline: string, lw: number, steep = 1): void {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const p of pts) {
    if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
    if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
  }
  const w = Math.max(2, (mxx - mnx) * 0.5 + (mxy - mny) * 0.35 * steep);
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  const g = ctx.createLinearGradient(cx + LIGHT_X * w, cy + LIGHT_Y * w, cx - LIGHT_X * w, cy - LIGHT_Y * w);
  g.addColorStop(0, tone(base, 0.26));
  g.addColorStop(0.5, base);
  g.addColorStop(1, tone(base, -0.24));
  poly(ctx, pts, g, outline, lw);
}

function ellipse(ctx: Ctx, c: Pt, rx: number, ry: number, fill: Fill, outline: string, lw: number, rot = 0): void {
  ctx.beginPath(); ctx.ellipse(c.x, c.y, Math.max(0.4, rx), Math.max(0.4, ry), rot, 0, TAU);
  ctx.fillStyle = fill; ctx.fill();
  if (lw > 0) { ctx.lineWidth = lw; ctx.strokeStyle = outline; ctx.stroke(); }
}

/** Shaded sphere head/hand volume with an optional offset highlight. */
function ball(ctx: Ctx, c: Pt, rx: number, ry: number, base: string, outline: string, lw: number): void {
  const g = ctx.createRadialGradient(c.x + LIGHT_X * rx * 0.4, c.y + LIGHT_Y * ry * 0.45, Math.min(rx, ry) * 0.1, c.x, c.y, Math.max(rx, ry) * 1.1);
  g.addColorStop(0, tone(base, 0.30));
  g.addColorStop(0.6, base);
  g.addColorStop(1, tone(base, -0.30));
  ellipse(ctx, c, rx, ry, g, outline, lw);
}

interface Part { d: number; draw: () => void }

// --------------------------------------------------------------------- poses

function basePose(spec: FigureSpec): Pose {
  const z = spec.kind === 'zombie' ? 0.60 : 0.64;
  return {
    hipL: -0.05, kneeL: 0.09, liftL: 0,
    hipR: 0.05, kneeR: 0.07, liftR: 0,
    handR: v3(0.10 + spec.hunch * 0.06, -0.085 * spec.build, z),
    weaponYaw: -0.14, weaponPitch: -0.10,
    torsoLean: spec.hunch * 0.42, torsoTwist: -0.06,
    headTilt: spec.hunch * 0.30, headYaw: 0,
    crouch: 0.06 + spec.hunch * 0.22, bob: 0, fall: 0, fallAxis: Math.PI / 2,
    shiftX: 0, shiftY: 0, armsOut: 0, scale: 1,
  };
}

/** Two-handed weapon carry: rear hand near the chest, muzzle forward. */
function holdWeapon(p: Pose, heath: number, pitch: number, yaw: number, chestZ: number): void {
  p.handR = v3(0.13 + heath * 0.05, -0.09, chestZ);
  p.weaponPitch = pitch;
  p.weaponYaw = yaw;
}

function zombieArms(p: Pose, phase: number, spec: FigureSpec): void {
  const s = Math.sin(phase * TAU), c = Math.cos(phase * TAU);
  p.armsOut = 1;
  const sy = spec.shamble;
  // Drive both hands directly. Deriving the support hand from the weapon
  // direction put both arms on one line, which from most facings collapsed the
  // silhouette into a single bundle of limbs; opposing them reads as a lurch.
  p.handR = v3(0.26 + 0.10 * s, -0.17 - 0.05 * sy + 0.03 * c, 0.58 + 0.09 * s);
  p.handL = v3(0.20 + 0.10 * c, 0.16 + 0.04 * sy, 0.52 + 0.08 * c);
  p.noWeapon = true;
}

export function poseFor(spec: FigureSpec, anim: AnimName, frame: number, phase: number): Pose {
  const p = basePose(spec);
  const s = Math.sin(phase * TAU), c = Math.cos(phase * TAU);
  const zombie = spec.kind === 'zombie';
  const sham = spec.shamble;

  switch (anim) {
    case 'idle': {
      p.bob = 0.004 * c;
      p.torsoLean += 0.01 * c;
      if (zombie) { zombieArms(p, phase, spec); p.torsoLean += 0.06 + 0.03 * s; p.headYaw = 0.10 * s; p.kneeL = 0.16 + 0.03 * c; p.kneeR = 0.14 - 0.03 * c; }
      else { holdWeapon(p, spec.hunch, -0.10, -0.16, 0.635); }
      break;
    }
    case 'walk': {
      const amp = zombie ? 0.34 : 0.44;
      if (zombie) {
        p.hipL = -amp * s - 0.06 * sham;
        p.hipR = amp * s + 0.04 * sham;
        p.kneeL = 0.30 + 0.42 * Math.max(0, Math.sin(phase * TAU + 2.3));
        p.kneeR = 0.26 + 0.42 * Math.max(0, Math.sin(phase * TAU + 2.3 + Math.PI));
        p.liftL = Math.max(0, Math.sin(phase * TAU + 1.1)) * 0.9;
        p.liftR = Math.max(0, Math.sin(phase * TAU + 1.1 + Math.PI)) * 0.5;
        p.torsoLean += 0.16;
        p.headTilt += 0.10;
        p.bob = -0.006 + 0.020 * Math.abs(Math.cos(phase * TAU));
        zombieArms(p, phase, spec);
      } else {
        p.hipL = -amp * s; p.hipR = amp * s;
        p.kneeL = 0.26 + 0.40 * Math.max(0, Math.sin(phase * TAU + 2.2));
        p.kneeR = 0.26 + 0.40 * Math.max(0, Math.sin(phase * TAU + 2.2 + Math.PI));
        p.liftL = Math.max(0, Math.sin(phase * TAU + 1.0)) * 0.55;
        p.liftR = Math.max(0, Math.sin(phase * TAU + 1.0 + Math.PI)) * 0.55;
        p.torsoLean += 0.05;
        p.bob = -0.006 + 0.016 * Math.abs(Math.cos(phase * TAU));
        holdWeapon(p, spec.hunch, -0.06 + 0.05 * s, -0.10, 0.645 + 0.012 * c);
      }
      break;
    }
    case 'run': {
      const amp = 0.72;
      p.hipL = -amp * s; p.hipR = amp * s;
      p.kneeL = 0.5 + 0.65 * Math.max(0, Math.sin(phase * TAU + 2.0));
      p.kneeR = 0.5 + 0.65 * Math.max(0, Math.sin(phase * TAU + 2.0 + Math.PI));
      p.liftL = Math.max(0, Math.sin(phase * TAU + 1.0)) * 1.3;
      p.liftR = Math.max(0, Math.sin(phase * TAU + 1.0 + Math.PI)) * 1.3;
      p.bob = -0.012 + 0.034 * Math.abs(Math.cos(phase * TAU));
      p.torsoLean += zombie ? 0.30 : 0.26;
      if (zombie) zombieArms(p, phase, spec);
      else holdWeapon(p, spec.hunch, -0.02, -0.30, 0.60 + 0.05 * c);
      break;
    }
    case 'aim': {
      if (zombie) { zombieArms(p, phase, spec); p.torsoLean += 0.08; break; }
      const br = frame === 0 ? 0 : 0.012;
      p.crouch = 0.14;
      p.torsoLean += 0.10;
      p.torsoTwist = -0.14;
      p.headTilt = -0.03;
      p.handR = v3(0.16 - br, -0.06, 0.775);
      p.weaponPitch = -0.03 + br * 0.6;
      p.weaponYaw = -0.05;
      p.hipL = -0.16; p.kneeL = 0.30;
      p.hipR = 0.10; p.kneeR = 0.24;
      break;
    }
    case 'shoot': {
      if (zombie) { zombieArms(p, phase, spec); p.torsoLean += 0.05; break; }
      const kick = frame === 0 ? 0 : 0.05;
      p.crouch = 0.15;
      p.torsoLean += 0.06;
      p.torsoTwist = -0.10 + kick;
      p.handR = v3(0.13 - kick * 0.6, -0.06, 0.775);
      p.weaponPitch = 0.02 + kick * 0.9;
      p.weaponYaw = -0.04;
      p.hipL = -0.18; p.kneeL = 0.32;
      p.hipR = 0.12; p.kneeR = 0.26;
      p.headTilt = -0.02;
      break;
    }
    case 'melee': {
      const k = frame;
      if (zombie) {
        zombieArms(p, phase, spec);
        p.torsoLean += 0.24 - k * 0.30;
        p.torsoTwist = 0.22 - k * 0.5;
        p.handR = v3(0.40 - k * 0.12, -0.20 + k * 0.14, 0.72 - k * 0.10);
        p.handR = v3(0.40 - k * 0.12, -0.20 + k * 0.14, 0.72 - k * 0.10);
        p.shiftX = k * 0.03;
      } else {
        p.crouch = 0.22;
        p.torsoLean += 0.20 - k * 0.16;
        p.torsoTwist = 0.24 - k * 0.30;
        p.handR = v3(0.20 + k * 0.06, -0.10 + k * 0.06, 0.70 - k * 0.05);
        p.weaponPitch = 0.32 - k * 0.20;
        p.weaponYaw = 0.18 - k * 0.22;
        p.hipL = -0.22; p.kneeL = 0.36; p.hipR = 0.16; p.kneeR = 0.30;
      }
      break;
    }
    case 'hit': {
      const k = frame;
      p.torsoLean -= 0.16 + k * 0.10;
      p.headTilt -= 0.14;
      p.bob = 0.01;
      p.shiftX = -0.03 - k * 0.03;
      p.hipL = 0.20; p.kneeL = 0.30; p.hipR = -0.06; p.kneeR = 0.34;
      if (zombie) { zombieArms(p, phase + 0.3, spec); p.handR = v3(0.16, -0.24, 0.74); p.handR = v3(0.16, -0.24, 0.74); }
      else { p.handR = v3(0.02, -0.16, 0.70); p.weaponPitch = -0.5; p.weaponYaw = 0.3; }
      break;
    }
  }
  return p;
}

// ------------------------------------------------------------------- drawing

export interface RenderResult { muzzle: { x: number; y: number } }

export function renderFigure(ctx: Ctx, spec: FigureSpec, anim: AnimName, frame: number, phase: number, dirAngle: number, ox: number, oy: number): RenderResult {
  const rad = (dirAngle * Math.PI) / 180;
  const pr: Proj = { c: Math.cos(rad), s: Math.sin(rad) };
  const p = poseFor(spec, anim, frame, phase);
  const j = buildJoints(spec, p);
  const P = (q: V3) => proj(q, pr);
  const D = (q: V3) => depthOf(q, pr);
  const col = spec.colors;
  const outline = col.outline;
  const lw = 1.5;
  const scale = p.scale;
  const parts: Part[] = [];

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  // grounding shadow (baked, so it costs nothing at runtime)
  {
    const rx = 0.175 * BP * spec.build;
    const ry = 0.090 * BP * spec.build;
    const g = ctx.createRadialGradient(3, 2, rx * 0.25, 3, 2, rx * 1.05);
    g.addColorStop(0, 'rgba(9,11,9,0.42)');
    g.addColorStop(0.65, 'rgba(9,11,9,0.26)');
    g.addColorStop(1, 'rgba(9,11,9,0)');
    ctx.beginPath(); ctx.ellipse(3, 2, rx, ry, 0, 0, TAU);
    ctx.fillStyle = g; ctx.fill();
  }

  const build2 = spec.build;
  const limbW = 0.062 * build2 * BP;
  const facing = Math.cos(rad);
  // Figure-facing light: a soldier with its back to the camera sits in its own
  // shade, which is most of what sells the eight directions as separate volumes.
  const toneK = -0.05 - 0.055 * (1 - facing);
  const T = (c: string) => tone(c, toneK);

  // --- local body frames, so gear sits square on the torso instead of being
  // hand-placed per direction
  const shoLp = P(j.shoL!), shoRp = P(j.shoR!), pelp = P(j.pelvis!), chestp = P(j.chest!);
  let upX = chestp.x - pelp.x, upY = chestp.y - pelp.y;
  const upL = Math.hypot(upX, upY) || 1;
  upX /= upL; upY /= upL;
  let riX = shoLp.x - shoRp.x, riY = shoLp.y - shoRp.y;
  const riL = Math.hypot(riX, riY) || 1;
  riX /= riL; riY /= riL;
  /** point at (right, up) from an origin, in the torso's screen frame */
  const loc = (o: Pt, right: number, up: number): Pt => ({ x: o.x + riX * right + upX * up, y: o.y + riY * right + upY * up });

  // --- legs
  const legDraw = (hip: V3, knee: V3, ankle: V3, toe: V3, front: boolean) => {
    const d = (D(hip) + D(knee) + D(ankle)) / 3;
    parts.push({
      d,
      draw: () => {
        const A = P(hip), B = P(knee), Cc = P(ankle), E = P(toe);
        const base = front ? col.legs : mixc(col.legs, col.legsShade, 0.55);
        tube(ctx, A, B, limbW * 1.34, limbW * 1.02, base, outline, lw);
        tube(ctx, B, Cc, limbW * 1.02, limbW * 0.80, base, outline, lw);
        // knee pad
        if (spec.kind === 'human') {
          joint(ctx, B, limbW * 0.62, col.gear, outline, lw * 0.7);
        }
        // boot: shape it into a sole plus a heel block rather than a wedge
        const ang = Math.atan2(E.y - Cc.y, E.x - Cc.x);
        ctx.save();
        ctx.translate(Cc.x, Cc.y);
        ctx.rotate(ang);
        plate(ctx, [
          { x: -limbW * 0.62, y: -limbW * 0.62 },
          { x: limbW * 1.45, y: -limbW * 0.55 },
          { x: limbW * 1.62, y: limbW * 0.34 },
          { x: -limbW * 0.70, y: limbW * 0.56 },
        ], col.boots, outline, lw * 0.75, 0.5);
        // sole
        ctx.beginPath();
        ctx.moveTo(-limbW * 0.70, limbW * 0.56);
        ctx.lineTo(limbW * 1.62, limbW * 0.34);
        ctx.lineWidth = limbW * 0.30;
        ctx.strokeStyle = tone(col.boots, -0.42);
        ctx.stroke();
        ctx.restore();
      },
    });
  };
  legDraw(j.hipL!, j.kneeL!, j.ankleL!, j.toeL!, true);
  legDraw(j.hipR!, j.kneeR!, j.ankleR!, j.toeR!, false);

  // --- backpack
  if (spec.backpack > 0.01) {
    const hw = 0.080 * build2;
    const lo = v3(-0.150 - spec.backpack * 0.05, 0, 0.505);
    const hi = v3(-0.070 - spec.backpack * 0.05, 0, 0.760);
    parts.push({
      d: D(lo) - 0.06,
      draw: () => {
        const bl = loc(P(lo), -0.055 * build2 * BP, 0);
        const br = loc(P(lo), 0.055 * build2 * BP, 0);
        const tl = loc(P(hi), -0.055 * build2 * BP, 0);
        const tr = loc(P(hi), 0.055 * build2 * BP, 0);
        plate(ctx, [tl, tr, br, bl], col.gear, outline, lw * 0.8);
        // top flap and buckles
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y);
        ctx.strokeStyle = tone(col.gear, -0.34); ctx.lineWidth = limbW * 0.42; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(bl.x, bl.y); ctx.lineTo(br.x, br.y);
        ctx.strokeStyle = tone(col.gear, -0.2); ctx.lineWidth = limbW * 0.3; ctx.stroke();
        ctx.restore();
        void hw;
      },
    });
  }

  // --- torso
  {
    const d = (D(j.pelvis!) + D(j.chest!)) / 2;
    parts.push({
      d,
      draw: () => {
        const hipL = loc(pelp, 0.078 * build2 * BP, 0);
        const hipR = loc(pelp, -0.078 * build2 * BP, 0);
        const wstL = loc(pelp, 0.070 * build2 * BP, 0.118 * BP);
        const wstR = loc(pelp, -0.070 * build2 * BP, 0.118 * BP);
        const cstL = loc(pelp, 0.076 * build2 * BP, 0.235 * BP);
        const cstR = loc(pelp, -0.076 * build2 * BP, 0.235 * BP);
        const body = [shoLp, cstL, wstL, hipL, hipR, wstR, cstR, shoRp];
        plate(ctx, body, T(col.torso), outline, lw);
        // shoulder shelf: a lit cap on each shoulder so the silhouette reads
        joint(ctx, shoLp, limbW * 0.62, T(col.torso), outline, lw * 0.7);
        joint(ctx, shoRp, limbW * 0.58, mixc(col.torso, col.torsoShade, 0.4), outline, lw * 0.7);
        // vest / plate carrier on the chest: 'up' runs toward the shoulders, so
        // both edges sit below the chest joint
        const vw = 0.060 * build2 * BP;
        const vTop = -0.050 * BP, vHem = -0.235 * BP;
        plate(ctx, [
          loc(chestp, vw, vTop),
          loc(chestp, -vw, vTop),
          loc(chestp, -vw * 0.92, vHem),
          loc(chestp, vw * 0.92, vHem),
        ], T(mixc(col.gear, col.torso, 0.25)), outline, lw * 0.75, 0.6);
        // pouches along the vest hem
        for (const s of [-1, 0, 1]) {
          const c = loc(chestp, s * vw * 0.55, vHem + 0.012 * BP);
          ellipse(ctx, c, vw * 0.28, 0.026 * BP, tone(col.gear, -0.14), outline, lw * 0.55);
        }
        // shoulder straps from the vest up over the shoulders
        ctx.save();
        ctx.strokeStyle = tone(col.gear, -0.24);
        ctx.lineWidth = limbW * 0.34;
        for (const s of [-1, 1]) {
          const a0 = loc(chestp, s * vw * 0.70, vTop);
          const a1 = loc(pelp, s * 0.068 * build2 * BP, 0.268 * BP);
          ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.stroke();
        }
        ctx.restore();
        if (spec.belt) {
          ctx.save();
          ctx.strokeStyle = tone(col.gear, -0.3);
          ctx.lineWidth = limbW * 0.5;
          ctx.beginPath();
          const b0 = loc(pelp, 0.076 * build2 * BP, 0.030 * BP);
          const b1 = loc(pelp, -0.076 * build2 * BP, 0.030 * BP);
          ctx.moveTo(b0.x, b0.y); ctx.lineTo(b1.x, b1.y); ctx.stroke();
          ellipse(ctx, loc(pelp, 0, 0.030 * BP), limbW * 0.28, limbW * 0.30, tone(col.accent, 0.05), outline, lw * 0.5);
          ctx.restore();
        }
        if (spec.kind === 'zombie') {
          // torn shirt hem and a blood stain
          ctx.save();
          ctx.fillStyle = 'rgba(70,26,24,0.42)';
          ctx.beginPath();
          ctx.ellipse(loc(chestp, -0.02 * BP, 0.10 * BP).x, loc(chestp, -0.02 * BP, 0.10 * BP).y, vw * 0.7, 0.052 * BP, 0.3, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
      },
    });
  }

  // --- arms
  const armDraw = (sho: V3, elbow: V3, hand: V3, front: boolean) => {
    const d = (D(sho) + D(elbow) + D(hand)) / 3 + (front ? 0.01 : -0.01);
    parts.push({
      d,
      draw: () => {
        const A = P(sho), B = P(elbow), Cc = P(hand);
        const base = front ? T(col.torso) : mixc(col.torso, col.torsoShade, 0.5);
        tube(ctx, A, B, limbW * 1.22, limbW * 0.96, base, outline, lw);
        tube(ctx, B, Cc, limbW * 0.94, limbW * 0.78, base, outline, lw);
        // unit armband, worn on the upper arm
        if (front && spec.armband) {
          const mid = { x: lerp(A.x, B.x, 0.62), y: lerp(A.y, B.y, 0.62) };
          ctx.save();
          ctx.translate(mid.x, mid.y);
          ctx.rotate(Math.atan2(B.y - A.y, B.x - A.x));
          ctx.fillStyle = spec.armband;
          ctx.fillRect(-limbW * 0.34, -limbW * 0.70, limbW * 0.68, limbW * 0.44);
          ctx.restore();
        }
        // glove: palm plus a thumb nub so the hand is not just a disc
        const ang = Math.atan2(Cc.y - B.y, Cc.x - B.x);
        ctx.save();
        ctx.translate(Cc.x, Cc.y);
        ctx.rotate(ang);
        ball(ctx, { x: 0, y: 0 }, limbW * 0.60, limbW * 0.56, spec.kind === 'zombie' ? T(col.skin) : tone(col.gear, -0.16), outline, lw * 0.7);
        ellipse(ctx, { x: limbW * 0.30, y: -limbW * 0.44 }, limbW * 0.30, limbW * 0.19, spec.kind === 'zombie' ? T(col.skin) : tone(col.gear, -0.26), outline, lw * 0.5, -0.5);
        ctx.restore();
        if (spec.kind === 'human') joint(ctx, B, limbW * 0.52, tone(col.gear, -0.06), outline, lw * 0.6);
      },
    });
  };
  armDraw(j.shoL!, j.elbowL!, j.handL!, true);
  armDraw(j.shoR!, j.elbowR!, j.handR!, false);

  // --- head
  {
    const d = D(j.head!) + 0.02;
    parts.push({
      d,
      draw: () => {
        const H = P(j.head!);
        const N = P(j.neck!);
        const r = spec.headR * BP;
        const ry = spec.headR * CHAR_H * (spec.height > 0.99 ? 1.12 : 1.0);
        // neck
        tube(ctx, N, H, limbW * 0.86, limbW * 0.78, tone(col.skinShade, -0.04), outline, lw * 0.7);
        // skull: cranium, jaw, ear
        ball(ctx, H, r, ry, T(col.skin), outline, lw);
        ellipse(ctx, { x: H.x + riX * r * 0.30, y: H.y + ry * 0.34 }, r * 0.62, ry * 0.40, tone(col.skin, -0.10), 'transparent', 0);
        ellipse(ctx, { x: H.x - riX * r * 0.86, y: H.y + ry * 0.02 }, r * 0.24, ry * 0.30, tone(col.skin, -0.16), outline, lw * 0.4);
        // hair under the headgear
        ellipse(ctx, { x: H.x, y: H.y - ry * 0.42 }, r * 1.02, ry * 0.46, mixc(col.hair, col.skin, 0.2), 'transparent', 0);
        // face: brow shade, eyes, mouth
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(H.x, H.y + ry * 0.20, r * 0.90, ry * 0.70, 0, 0, TAU);
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fill();
        if (facing > -0.15) {
          const ex = r * 0.36, ey = -ry * 0.06;
          ctx.fillStyle = 'rgba(18,16,14,0.8)';
          ctx.beginPath(); ctx.ellipse(H.x - ex * facing, H.y + ey, r * 0.145, ry * 0.115, 0, 0, TAU); ctx.fill();
          ctx.beginPath(); ctx.ellipse(H.x + ex * facing, H.y + ey, r * 0.145, ry * 0.115, 0, 0, TAU); ctx.fill();
          // nose
          ctx.fillStyle = 'rgba(0,0,0,0.14)';
          ctx.beginPath();
          ctx.ellipse(H.x + facing * r * 0.05, H.y + ry * 0.20, r * 0.16, ry * 0.13, 0, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
        if (spec.kind === 'zombie') {
          // slack jaw and blood down the chin
          ellipse(ctx, { x: H.x, y: H.y + ry * 0.52 }, r * 0.58, ry * 0.30, tone(col.skinShade, -0.14), 'transparent', 0);
          ctx.fillStyle = 'rgba(84,26,22,0.55)';
          ctx.beginPath();
          ctx.ellipse(H.x + r * 0.16, H.y + ry * 0.60, r * 0.42, ry * 0.26, 0.35, 0, TAU);
          ctx.fill();
        }
        // headgear
        const gcol = T(col.gear);
        if (spec.headgear === 'helmet') {
          // dome, cover band, brim, centre ridge
          ctx.beginPath();
          ctx.ellipse(H.x, H.y - ry * 0.10, r * 1.32, ry * 1.12, 0, Math.PI, TAU);
          ctx.fillStyle = gcol;
          ctx.fill();
          ctx.lineWidth = lw * 0.9; ctx.strokeStyle = outline; ctx.stroke();
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(H.x, H.y - ry * 0.10, r * 1.32, ry * 1.12, 0, Math.PI * 1.06, Math.PI * 1.94);
          ctx.strokeStyle = tone(col.gear, -0.34);
          ctx.lineWidth = ry * 0.30;
          ctx.stroke();
          ctx.restore();
          // brim
          ctx.beginPath();
          ctx.ellipse(H.x, H.y - ry * 0.12, r * 1.36, ry * 0.26, 0, 0, TAU);
          ctx.fillStyle = tone(col.gear, -0.10);
          ctx.fill();
          ctx.lineWidth = lw * 0.7; ctx.strokeStyle = outline; ctx.stroke();
          // centre ridge highlight
          ctx.beginPath();
          ctx.moveTo(H.x - riX * r * 0.9, H.y - ry * 0.95);
          ctx.lineTo(H.x + riX * r * 0.9, H.y - ry * 0.95);
          ctx.strokeStyle = tone(col.gear, 0.22);
          ctx.lineWidth = lw * 0.9;
          ctx.stroke();
          // chin strap
          ctx.beginPath();
          ctx.moveTo(H.x - riX * r * 1.28, H.y - ry * 0.10);
          ctx.lineTo(H.x - riX * r * 0.44, H.y + ry * 0.86);
          ctx.strokeStyle = tone(col.gear, -0.4);
          ctx.lineWidth = lw * 0.6;
          ctx.stroke();
        } else if (spec.headgear === 'cap') {
          ctx.beginPath();
          ctx.ellipse(H.x, H.y - ry * 0.24, r * 1.16, ry * 0.90, 0, Math.PI, TAU);
          ctx.fillStyle = gcol; ctx.fill();
          ctx.lineWidth = lw * 0.8; ctx.strokeStyle = outline; ctx.stroke();
          // visor points the way the figure faces
          const vd = loc({ x: H.x, y: H.y }, facing * r * 1.9, -ry * 0.16);
          ctx.beginPath();
          ctx.moveTo(H.x - riX * r * 1.05, H.y - ry * 0.22);
          ctx.lineTo(H.x + riX * r * 1.05, H.y - ry * 0.22);
          ctx.lineTo(vd.x, vd.y);
          ctx.closePath();
          ctx.fillStyle = tone(col.gear, -0.16); ctx.fill();
          ctx.lineWidth = lw * 0.6; ctx.strokeStyle = outline; ctx.stroke();
        } else if (spec.headgear === 'med') {
          ctx.beginPath();
          ctx.ellipse(H.x, H.y - ry * 0.14, r * 1.30, ry * 1.06, 0, Math.PI, TAU);
          ctx.fillStyle = gcol; ctx.fill();
          ctx.lineWidth = lw * 0.9; ctx.strokeStyle = outline; ctx.stroke();
          ctx.fillStyle = '#c8524c';
          ctx.fillRect(H.x - r * 0.60, H.y - ry * 0.72, r * 1.20, ry * 0.22);
          ctx.fillRect(H.x - r * 0.15, H.y - ry * 1.02, r * 0.30, ry * 0.68);
        } else if (spec.headgear === 'beret') {
          ctx.beginPath();
          ctx.ellipse(H.x - riX * r * 0.22, H.y - ry * 0.46, r * 1.22, ry * 0.72, -0.22, 0, TAU);
          ctx.fillStyle = col.accent; ctx.fill();
          ctx.lineWidth = lw * 0.6; ctx.strokeStyle = outline; ctx.stroke();
        } else if (spec.kind === 'zombie') {
          // matted hair
          ellipse(ctx, { x: H.x, y: H.y - ry * 0.34 }, r * 1.10, ry * 0.52, tone(col.hair, -0.06), 'transparent', 0);
        }
      },
    });
  }

  // --- weapon
  let muzzleScreen = { x: 0, y: 0 };
  if (spec.weapon !== 'none' && !p.noWeapon) {
    const wdir = norm(rotZ(rotY(v3(1, 0, 0), p.weaponPitch), p.weaponYaw));
    const grip = j.handR!;
    const cfg = WEAPONS[spec.weapon];
    const muzzle = add(grip, mul(wdir, cfg.len));
    const d = (D(grip) + D(muzzle)) / 2 - 0.02;
    parts.push({
      d,
      draw: () => {
        const A = P(add(grip, mul(wdir, -cfg.back)));
        const B = P(muzzle);
        const hand = P(grip);
        const ang = Math.atan2(B.y - A.y, B.x - A.x);
        const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
        const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
        const at = (f: number, off: number): Pt => ({ x: A.x + ux * len * f - uy * off, y: A.y + uy * len * f + ux * off });
        ctx.save();
        // stock
        poly(ctx, [
          at(0.00, -limbW * 0.42), at(0.24, -limbW * 0.30),
          at(0.24, limbW * 0.34), at(0.02, limbW * 0.52),
        ], tone(col.weaponDark, -0.06), outline, lw * 0.6);
        // receiver through the grip
        poly(ctx, [
          at(0.22, -limbW * 0.34), at(0.48, -limbW * 0.30),
          at(0.48, limbW * 0.30), at(0.22, limbW * 0.34),
        ], tone(col.weaponDark, 0.10), outline, lw * 0.6);
        // handguard
        poly(ctx, [
          at(0.46, -limbW * 0.28), at(0.74, -limbW * 0.24),
          at(0.74, limbW * 0.26), at(0.46, limbW * 0.28),
        ], col.weaponDark, outline, lw * 0.6);
        // barrel
        poly(ctx, [
          at(0.72, -limbW * 0.14), at(1.00, -limbW * 0.12),
          at(1.00, limbW * 0.12), at(0.72, limbW * 0.14),
        ], tone(col.weapon, -0.06), outline, lw * 0.5);
        // muzzle device
        ellipse(ctx, at(0.99, 0), limbW * 0.19, limbW * 0.26, '#1e201d', 'transparent', 0);
        // front sight
        ctx.beginPath();
        ctx.moveTo(at(0.80, -limbW * 0.22).x, at(0.80, -limbW * 0.22).y);
        ctx.lineTo(at(0.80, -limbW * 0.78).x, at(0.80, -limbW * 0.78).y);
        ctx.lineWidth = lw * 0.7; ctx.strokeStyle = tone(col.weaponDark, -0.2); ctx.stroke();
        // pistol grip and magazine
        poly(ctx, [
          at(0.30, limbW * 0.28), at(0.40, limbW * 0.26),
          at(0.36, limbW * 1.30), at(0.24, limbW * 1.24),
        ], tone(col.weaponDark, -0.12), outline, lw * 0.5);
        poly(ctx, [
          at(0.42, limbW * 0.30), at(0.60, limbW * 0.28),
          at(0.56, limbW * 1.55), at(0.34, limbW * 1.62),
        ], tone(col.weaponDark, -0.04), outline, lw * 0.55);
        // optic / sight block with a lens glint
        if (cfg.scope) {
          const s0 = at(0.40, -limbW * 0.44), s1 = at(0.66, -limbW * 0.40);
          ctx.beginPath();
          ctx.moveTo(s0.x, s0.y - limbW * 0.34); ctx.lineTo(s1.x, s1.y - limbW * 0.34);
          ctx.lineTo(s1.x, s1.y + limbW * 0.10); ctx.lineTo(s0.x, s0.y + limbW * 0.10);
          ctx.closePath();
          ctx.fillStyle = tone(col.weaponDark, -0.22); ctx.fill();
          ctx.lineWidth = lw * 0.5; ctx.strokeStyle = outline; ctx.stroke();
          ellipse(ctx, { x: s0.x, y: s0.y - limbW * 0.12 }, limbW * 0.16, limbW * 0.22, '#7d8f96', 'transparent', 0);
        } else {
          const r0 = at(0.52, -limbW * 0.36);
          ctx.beginPath();
          ctx.moveTo(r0.x - uy * limbW * 0.18, r0.y + ux * limbW * 0.18);
          ctx.lineTo(r0.x - uy * limbW * 0.18, r0.y + ux * limbW * 0.18 - limbW * 0.52);
          ctx.lineWidth = limbW * 0.26; ctx.strokeStyle = tone(col.weaponDark, -0.24); ctx.stroke();
        }
        if (cfg.bipod) {
          ctx.beginPath();
          ctx.moveTo(at(0.70, 0).x, at(0.70, 0).y);
          ctx.lineTo(at(0.66, limbW * 1.10).x, at(0.66, limbW * 1.10).y);
          ctx.moveTo(at(0.70, 0).x, at(0.70, 0).y);
          ctx.lineTo(at(0.74, -limbW * 1.02).x, at(0.74, -limbW * 1.02).y);
          ctx.lineWidth = lw * 0.7; ctx.strokeStyle = tone(col.weaponDark, -0.15); ctx.stroke();
        }
        // sling from the stock up over the shoulder
        ctx.beginPath();
        ctx.moveTo(at(0.06, 0).x, at(0.06, 0).y);
        const sl = loc(chestp, 0.052 * build2 * BP, 0.250 * BP);
        ctx.lineTo(sl.x, sl.y);
        ctx.strokeStyle = 'rgba(24,26,24,0.55)';
        ctx.lineWidth = lw * 0.6;
        ctx.stroke();
        ctx.restore();
        void ang; void hand;
        muzzleScreen = B;
      },
    });
  } else {
    muzzleScreen = P(j.handR!);
  }

  parts.sort((a, b) => a.d - b.d);
  for (const part of parts) part.draw();
  ctx.restore();
  return { muzzle: muzzleScreen };
}

interface WeaponCfg { len: number; back: number; scope: boolean; bipod: boolean }
const WEAPONS: Record<Exclude<WeaponKind, 'none'>, WeaponCfg> = {
  rifle: { len: 0.44, back: 0.17, scope: false, bipod: false },
  lmg: { len: 0.50, back: 0.20, scope: false, bipod: true },
  shotgun: { len: 0.36, back: 0.16, scope: false, bipod: false },
  pistol: { len: 0.22, back: 0.09, scope: false, bipod: false },
};

// ------------------------------------------------------------------- palettes

function C(o: Partial<FigureColors>): FigureColors {
  return {
    skin: '#cba183', skinShade: '#a8835f', hair: '#3a3229',
    torso: '#8d938d', torsoShade: '#6b716c', legs: '#767d78', legsShade: '#5b625e',
    boots: '#3a3d3e', gear: '#59626a', weapon: '#4a4e4b', weaponDark: '#34383a',
    accent: '#b3b8b5', outline: 'rgba(18,20,19,0.62)', ...o,
  };
}

export const FIGURE_SPECS: Record<string, FigureSpec> = {
  rifleman: {
    id: 'rifleman', kind: 'human', build: 1.0, height: 1.0, headR: 0.062, shoulderHalf: 0.104,
    colors: C({ torso: '#98a09a', torsoShade: '#767d78', legs: '#828985', legsShade: '#666d69', gear: '#5d686f', accent: '#8fa88f', weapon: '#4e5250' }),
    headgear: 'helmet', weapon: 'rifle', backpack: 0.45, hunch: 0, shamble: 0, belt: true, armband: '#5f7d63',
  },
  gunner: {
    id: 'gunner', kind: 'human', build: 1.16, height: 1.0, headR: 0.061, shoulderHalf: 0.118,
    colors: C({ torso: '#878f89', torsoShade: '#69706b', legs: '#767d78', legsShade: '#5c635f', gear: '#4e585e', accent: '#b09468', weapon: '#565b52' }),
    headgear: 'helmet', weapon: 'lmg', backpack: 0.85, hunch: 0, shamble: 0, belt: true, armband: '#b09468', bulky: 1.15,
  },
  breacher: {
    id: 'breacher', kind: 'human', build: 1.08, height: 0.965, headR: 0.060, shoulderHalf: 0.112,
    colors: C({ torso: '#a0a5a0', torsoShade: '#7c827d', legs: '#858b86', legsShade: '#686e6a', gear: '#6a6152', accent: '#c19a5c' }),
    headgear: 'cap', weapon: 'shotgun', backpack: 0.3, hunch: 0, shamble: 0, belt: true, armband: '#c19a5c',
  },
  medic: {
    id: 'medic', kind: 'human', build: 0.97, height: 1.0, headR: 0.062, shoulderHalf: 0.100,
    colors: C({ torso: '#adb3ae', torsoShade: '#868c88', legs: '#8c9390', legsShade: '#6d7471', gear: '#6d8577', accent: '#d9615a', skin: '#d0a884' }),
    headgear: 'med', weapon: 'rifle', backpack: 0.7, hunch: 0, shamble: 0, belt: false, armband: '#d9615a',
  },
  walker: {
    id: 'walker', kind: 'zombie', build: 1.0, height: 1.0, headR: 0.063, shoulderHalf: 0.106,
    colors: C({ skin: '#8b9375', skinShade: '#6d7459', torso: '#565648', torsoShade: '#404036', legs: '#4b4b40', legsShade: '#393930', gear: '#4a4a3f', boots: '#33332d', accent: '#7d332c' }),
    headgear: 'none', weapon: 'none', backpack: 0, hunch: 0.55, shamble: 1.0, belt: false,
  },
  runner: {
    id: 'runner', kind: 'zombie', build: 0.9, height: 0.99, headR: 0.060, shoulderHalf: 0.096,
    colors: C({ skin: '#96816a', skinShade: '#75634f', torso: '#655a51', torsoShade: '#4c443d', legs: '#584f45', legsShade: '#453e36', gear: '#4a4a3f', boots: '#33332d', accent: '#8b3730' }),
    headgear: 'none', weapon: 'none', backpack: 0, hunch: 0.82, shamble: 0.5, belt: false,
  },
  brute: {
    id: 'brute', kind: 'zombie', build: 1.5, height: 1.2, headR: 0.070, shoulderHalf: 0.152,
    colors: C({ skin: '#7d8466', skinShade: '#61674e', torso: '#4e4f43', torsoShade: '#3a3b31', legs: '#454639', legsShade: '#34352c', gear: '#43443a', boots: '#2e2e28', accent: '#7d332c' }),
    headgear: 'none', weapon: 'none', backpack: 0, hunch: 0.42, shamble: 0.7, belt: false, bulky: 1.4,
  },
};

// -------------------------------------------------------------------- corpses

export function renderCorpse(ctx: Ctx, spec: FigureSpec, variant: number, ox: number, oy: number, rot: number): void {
  const pr: Proj = { c: Math.cos(rot), s: Math.sin(rot) };
  const col = spec.colors;
  const outline = col.outline;
  ctx.save();
  ctx.translate(ox, oy);
  const prone = variant % 3;
  const flat = (q: V3): { x: number; y: number } => {
    const gx = q.x * pr.c - q.y * pr.s;
    const gy = (q.x * pr.s + q.y * pr.c) * PITCH;
    return { x: gx * BP * 0.82, y: gy * BP * 0.82 - q.z * CHAR_H * 0.82 };
  };
  const parts: Part[] = [];
  const shadow = () => {
    ctx.beginPath();
    ctx.ellipse(0, 0, 26, 15, 0, 0, TAU);
    ctx.fillStyle = 'rgba(8,9,8,0.30)';
    ctx.fill();
  };
  shadow();
  if (prone === 0) {
    // face down
    const hip = v3(0, 0, 0.10), sho = v3(0.40, 0, 0.12), head = v3(0.56, 0.02, 0.14);
    parts.push({ d: 0, draw: () => {
      const A = flat(hip), B = flat(sho);
      limb(ctx, A, B, 26, 24, col.torso, outline, 1.6);
      limb(ctx, B, flat(head), 16, 15, col.skinShade, outline, 1.4);
      limb(ctx, A, flat(v3(-0.30, 0.16, 0.06)), 12, 9, col.legs, outline, 1.4);
      limb(ctx, A, flat(v3(-0.26, -0.18, 0.06)), 12, 9, col.legs, outline, 1.4);
      limb(ctx, B, flat(v3(0.52, 0.28, 0.07)), 9, 7, col.torsoShade, outline, 1.2);
      limb(ctx, B, flat(v3(0.50, -0.26, 0.07)), 9, 7, col.torsoShade, outline, 1.2);
    } });
  } else if (prone === 1) {
    // curled on the side
    const hip = v3(0, 0, 0.12);
    parts.push({ d: 0, draw: () => {
      const A = flat(hip), B = flat(v3(0.26, 0.16, 0.14));
      limb(ctx, A, B, 27, 22, col.torso, outline, 1.6);
      limb(ctx, B, flat(v3(0.40, 0.26, 0.13)), 15, 14, col.skinShade, outline, 1.4);
      limb(ctx, A, flat(v3(-0.22, 0.26, 0.10)), 12, 9, col.legs, outline, 1.4);
      limb(ctx, flat(v3(-0.22, 0.26, 0.09)), flat(v3(0.02, 0.40, 0.08)), 10, 8, col.legsShade, outline, 1.3);
      limb(ctx, B, flat(v3(0.44, 0.06, 0.09)), 9, 7, col.torsoShade, outline, 1.2);
    } });
  } else {
    // sprawled on the back
    const hip = v3(0, 0, 0.09), sho = v3(-0.38, 0, 0.11), head = v3(-0.54, 0.04, 0.13);
    parts.push({ d: 0, draw: () => {
      const A = flat(hip), B = flat(sho);
      limb(ctx, A, B, 26, 23, col.torsoShade, outline, 1.6);
      limb(ctx, B, flat(head), 16, 15, col.skin, outline, 1.4);
      limb(ctx, A, flat(v3(0.30, 0.20, 0.06)), 12, 9, col.legs, outline, 1.4);
      limb(ctx, A, flat(v3(0.28, -0.20, 0.06)), 12, 9, col.legs, outline, 1.4);
      limb(ctx, B, flat(v3(-0.50, 0.30, 0.06)), 9, 7, col.torso, outline, 1.2);
      limb(ctx, B, flat(v3(-0.48, -0.28, 0.06)), 9, 7, col.torso, outline, 1.2);
    } });
  }
  for (const part of parts) part.draw();
  ctx.restore();
}

export { lerp };
