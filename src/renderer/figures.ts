// Miniature-figure renderer.
//
// A figure is posed as a small 3D skeleton in body space (x = forward, y = right,
// z = up) and projected with the *same* axonometric transform the game camera
// uses. Because the projection happens at bake time we get consistent 3/4 views
// for every facing, real volume, and correct limb occlusion for free.
//
// The atlas cell is 96x96 with the feet anchored at (48, 88).

import { TAU, clamp, lerp } from '../core/math';
import { PITCH, ZSCALE } from '../core/config';
import type { AnimName } from '../entities/anim';

export const CELL = 96;
export const CHAR_H = 60;
export const BP = CHAR_H / ZSCALE; // px per body-unit of ground extent
export const FEET_ROW = 78;

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
  const handL = add(handR, mul(weaponDir, 0.255));

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

function poly(ctx: Ctx, pts: Array<{ x: number; y: number }>, fill: string, outline: string, lw: number): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (lw > 0) { ctx.lineWidth = lw; ctx.strokeStyle = outline; ctx.stroke(); }
}

function limb(ctx: Ctx, a: { x: number; y: number }, b: { x: number; y: number }, wa: number, wb: number, fill: string, outline: string, lw: number): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l;
  const pts = [
    { x: a.x + nx * wa * 0.5, y: a.y + ny * wa * 0.5 },
    { x: b.x + nx * wb * 0.5, y: b.y + ny * wb * 0.5 },
    { x: b.x - nx * wb * 0.5, y: b.y - ny * wb * 0.5 },
    { x: a.x - nx * wa * 0.5, y: a.y - ny * wa * 0.5 },
  ];
  poly(ctx, pts, fill, outline, lw);
  // rounded joints
  ctx.beginPath(); ctx.arc(b.x, b.y, wb * 0.5, 0, TAU); ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath(); ctx.arc(a.x, a.y, wa * 0.5, 0, TAU); ctx.fillStyle = fill; ctx.fill();
  if (lw > 0) {
    ctx.lineWidth = lw; ctx.strokeStyle = outline;
    ctx.beginPath(); ctx.arc(a.x, a.y, wa * 0.5, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(b.x, b.y, wb * 0.5, 0, TAU); ctx.stroke();
  }
}

function ellipse(ctx: Ctx, c: { x: number; y: number }, rx: number, ry: number, fill: string, outline: string, lw: number): void {
  ctx.beginPath(); ctx.ellipse(c.x, c.y, Math.max(0.4, rx), Math.max(0.4, ry), 0, 0, TAU);
  ctx.fillStyle = fill; ctx.fill();
  if (lw > 0) { ctx.lineWidth = lw; ctx.strokeStyle = outline; ctx.stroke(); }
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
  p.handR = v3(0.30 + 0.05 * s, -0.16 - 0.05 * sy + 0.03 * c, 0.66 + 0.05 * s);
  p.handR = v3(0.30 + 0.05 * s, -0.16 - 0.05 * sy + 0.03 * c, 0.66 + 0.05 * s);
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
    case 'death': {
      const k = frame / 5;
      const back = !zombie;
      const ang = back ? -1.62 * k * k : 1.72 * k * (1.2 - 0.2 * k);
      p.fall = ang;
      p.fallAxis = Math.PI / 2;
      p.crouch = 0.1 + 0.5 * Math.min(1, k * 2.2);
      p.torsoLean = (zombie ? 0.35 : 0.1) + 0.5 * k;
      p.headTilt = (zombie ? 0.3 : -0.2) * k;
      if (zombie) { zombieArms(p, phase + k * 2, spec); p.handR = v3(0.30 - k * 0.30, -0.22 + k * 0.10, 0.62 - k * 0.5); p.handR = v3(0.30 - k * 0.30, -0.22 + k * 0.10, 0.62 - k * 0.5); }
      else { p.handR = v3(0.10 - k * 0.2, -0.14 - k * 0.1, 0.62 - k * 0.45); p.weaponPitch = -0.2 - k * 0.5; p.weaponYaw = 0.2 + k * 0.4; }
      // fold the legs under so the body collapses instead of hinging rigidly
      p.hipL = -0.5 - 0.4 * k; p.kneeL = 0.5 + 1.5 * k;
      p.hipR = -0.3 - 0.5 * k; p.kneeR = 0.4 + 1.6 * k;
      p.bob = -0.02 * k;
      // drift the pivot back toward the cell centre so nothing clips
      const drift = back ? -0.14 * k : 0.16 * k;
      p.shiftX = drift * Math.cos(p.fallAxis) * 0;
      p.shiftX = 0;
      p.shiftY = 0;
      p.fallAxis = back ? Math.PI / 2 : Math.PI / 2;
      p.scale = 1 - 0.06 * k;
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
  const lw = 1.4;
  const scale = p.scale;
  const parts: Part[] = [];

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  // grounding shadow (baked, so it costs nothing at runtime)
  ctx.beginPath();
  ctx.ellipse(2, 1, 0.155 * BP * spec.build, 0.080 * BP * spec.build, 0, 0, TAU);
  ctx.fillStyle = 'rgba(10,12,10,0.34)';
  ctx.fill();

  const build2 = spec.build;
  const torsoW = 0.20 * build2;
  // Body-unit thicknesses converted to atlas pixels.
  const limbW = 0.062 * build2 * BP;
  void torsoW;

  // --- legs
  const legDraw = (hip: V3, knee: V3, ankle: V3, toe: V3, front: boolean) => {
    const d = (D(hip) + D(knee) + D(ankle)) / 3;
    parts.push({
      d,
      draw: () => {
        const A = P(hip), B = P(knee), C = P(ankle), E = P(toe);
        limb(ctx, A, B, limbW * 1.25, limbW * 1.05, front ? col.legs : col.legsShade, outline, lw);
        limb(ctx, B, C, limbW * 1.05, limbW * 0.85, front ? col.legs : col.legsShade, outline, lw);
        // boot
        const ang = Math.atan2(E.y - C.y, E.x - C.x);
        ctx.save();
        ctx.translate(C.x, C.y);
        ctx.rotate(ang);
        poly(ctx, [
          { x: -limbW * 0.55, y: -limbW * 0.55 },
          { x: limbW * 1.5, y: -limbW * 0.5 },
          { x: limbW * 1.6, y: limbW * 0.55 },
          { x: -limbW * 0.55, y: limbW * 0.6 },
        ], col.boots, outline, lw * 0.8);
        ctx.restore();
      },
    });
  };
  legDraw(j.hipL!, j.kneeL!, j.ankleL!, j.toeL!, true);
  legDraw(j.hipR!, j.kneeR!, j.ankleR!, j.toeR!, false);

  // --- backpack
  if (spec.backpack > 0.01) {
    const hw = 0.072 * build2;
    const lo = v3(-0.155 - spec.backpack * 0.05, 0, 0.50);
    const hi = v3(-0.075 - spec.backpack * 0.05, 0, 0.755);
    parts.push({
      d: D(lo) - 0.06,
      draw: () => {
        const c000 = P(add(lo, v3(0, -hw, 0))), c100 = P(add(lo, v3(0, hw, 0)));
        const c011 = P(add(hi, v3(0, -hw, 0))), c111 = P(add(hi, v3(0, hw, 0)));
        const face = [c000, c100, c111, c011];
        poly(ctx, face, col.gear, outline, lw * 0.8);
        // strap hint
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(c111.x, c111.y); ctx.lineTo(c011.x, c011.y);
        ctx.strokeStyle = 'rgba(15,17,15,0.5)'; ctx.lineWidth = lw * 0.8; ctx.stroke();
        ctx.restore();
      },
    });
  }

  // --- torso
  {
    const d = (D(j.pelvis!) + D(j.chest!)) / 2;
    parts.push({
      d,
      draw: () => {
        const hipL = P(add(j.pelvis!, rotZ(rotY(v3(0, 0.072 * build2, 0), p.torsoLean), p.torsoTwist)));
        const hipR = P(add(j.pelvis!, rotZ(rotY(v3(0, -0.072 * build2, 0), p.torsoLean), p.torsoTwist)));
        const shoL = P(j.shoL!);
        const shoR = P(j.shoR!);
        poly(ctx, [shoL, shoR, hipR, hipL], col.torso, outline, lw);
        // shading on the rear half
        const mid = P(j.chest!);
        ctx.save();
        ctx.globalAlpha = 0.28;
        poly(ctx, [mid, shoR, hipR, { x: (hipR.x + hipL.x) / 2, y: (hipR.y + hipL.y) / 2 }], col.torsoShade, 'transparent', 0);
        ctx.restore();
        if (spec.belt) {
          const a = P(add(j.pelvis!, v3(0, 0, 0.045)));
          ctx.beginPath();
          ctx.moveTo(hipL.x, hipL.y - 2);
          ctx.lineTo(hipR.x, hipR.y - 2);
          ctx.lineWidth = limbW * 0.9;
          ctx.strokeStyle = col.gear;
          ctx.stroke();
          void a;
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
        const A = P(sho), B = P(elbow), C = P(hand);
        const c1 = front ? col.torso : col.torsoShade;
        limb(ctx, A, B, limbW * 1.15, limbW * 0.95, c1, outline, lw);
        limb(ctx, B, C, limbW * 0.95, limbW * 0.8, c1, outline, lw);
        ellipse(ctx, C, limbW * 0.62, limbW * 0.62, col.skin, outline, lw * 0.8);
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
        const r = spec.headR * BP;
        const ry = spec.headR * CHAR_H;
        // neck
        const N = P(j.neck!);
        limb(ctx, N, H, limbW * 0.8, limbW * 0.8, col.skinShade, outline, lw * 0.8);
        ellipse(ctx, H, r, ry, col.skin, outline, lw);
        // face hint: darker lower half + eyes when facing the camera
        const facing = Math.cos(rad);
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(H.x, H.y + ry * 0.18, r * 0.92, ry * 0.72, 0, 0, TAU);
        ctx.fillStyle = 'rgba(0,0,0,0.13)';
        ctx.fill();
        if (Math.cos(rad + Math.PI / 2) > -0.2) {
          ctx.fillStyle = 'rgba(20,18,16,0.75)';
          const ex = r * 0.34, ey = -ry * 0.12;
          ctx.beginPath(); ctx.ellipse(H.x - ex * facing, H.y + ey, r * 0.13, ry * 0.13, 0, 0, TAU); ctx.fill();
          ctx.beginPath(); ctx.ellipse(H.x + ex * facing, H.y + ey, r * 0.13, ry * 0.13, 0, 0, TAU); ctx.fill();
        }
        ctx.restore();
        // headgear
        if (spec.headgear === 'helmet') {
          ctx.beginPath();
          ctx.ellipse(H.x, H.y - ry * 0.14, r * 1.22, ry * 1.02, 0, Math.PI, TAU);
          ctx.fillStyle = col.gear;
          ctx.fill();
          ctx.lineWidth = lw * 0.9; ctx.strokeStyle = outline; ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(H.x - r * 1.3, H.y - ry * 0.12);
          ctx.lineTo(H.x + r * 1.3, H.y - ry * 0.12);
          ctx.lineWidth = lw * 1.4; ctx.strokeStyle = col.gear; ctx.stroke();
        } else if (spec.headgear === 'cap') {
          ctx.beginPath();
          ctx.ellipse(H.x, H.y - ry * 0.2, r * 1.12, ry * 0.86, 0, Math.PI, TAU);
          ctx.fillStyle = col.gear; ctx.fill();
          ctx.lineWidth = lw * 0.8; ctx.strokeStyle = outline; ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(H.x, H.y - ry * 0.2);
          ctx.lineTo(H.x + r * 1.5 * facing, H.y - ry * 0.05);
          ctx.lineWidth = lw * 1.6; ctx.strokeStyle = col.gear; ctx.stroke();
        } else if (spec.headgear === 'med') {
          ctx.beginPath();
          ctx.ellipse(H.x, H.y - ry * 0.16, r * 1.2, ry * 0.98, 0, Math.PI, TAU);
          ctx.fillStyle = col.gear; ctx.fill();
          ctx.lineWidth = lw * 0.9; ctx.strokeStyle = outline; ctx.stroke();
          ctx.fillStyle = '#c8524c';
          ctx.fillRect(H.x - r * 0.55, H.y - ry * 0.62, r * 1.1, ry * 0.2);
          ctx.fillRect(H.x - r * 0.14, H.y - ry * 0.9, r * 0.28, ry * 0.62);
        } else if (spec.headgear === 'beret') {
          ctx.beginPath();
          ctx.ellipse(H.x - r * 0.1, H.y - ry * 0.34, r * 1.15, ry * 0.72, 0, Math.PI, TAU);
          ctx.fillStyle = col.accent; ctx.fill();
        }
        if (spec.kind === 'zombie') {
          ctx.fillStyle = 'rgba(70,26,24,0.5)';
          ctx.beginPath();
          ctx.ellipse(H.x + r * 0.2, H.y + ry * 0.42, r * 0.5, ry * 0.3, 0.4, 0, TAU);
          ctx.fill();
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
        // stock + receiver
        limb(ctx, A, hand, limbW * 0.75, limbW * 0.7, col.weaponDark, outline, lw * 0.7);
        limb(ctx, hand, B, limbW * 0.62, limbW * 0.38, col.weapon, outline, lw * 0.7);
        const ang = Math.atan2(B.y - A.y, B.x - A.x);
        // magazine
        ctx.save();
        ctx.translate(hand.x, hand.y);
        ctx.rotate(ang);
        poly(ctx, [
          { x: -limbW * 0.2, y: 0 }, { x: limbW * 0.5, y: 0 },
          { x: limbW * 0.4, y: limbW * 1.7 }, { x: -limbW * 0.3, y: limbW * 1.6 },
        ], col.weaponDark, outline, lw * 0.6);
        if (cfg.bipod) {
          ctx.beginPath();
          ctx.moveTo(limbW * 1.6, 0); ctx.lineTo(limbW * 2.6, limbW * 1.3);
          ctx.moveTo(limbW * 1.6, 0); ctx.lineTo(limbW * 0.8, limbW * 1.5);
          ctx.lineWidth = lw * 0.7; ctx.strokeStyle = col.weaponDark; ctx.stroke();
        }
        ctx.restore();
        if (cfg.scope) {
          const mid = P(add(grip, mul(wdir, cfg.len * 0.42)));
          ellipse(ctx, { x: mid.x, y: mid.y - limbW * 0.7 }, limbW * 0.5, limbW * 0.34, col.weaponDark, outline, lw * 0.5);
        }
        muzzleScreen = B;
        // muzzle ring
        ellipse(ctx, B, limbW * 0.3, limbW * 0.3, '#22241f', 'transparent', 0);
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
