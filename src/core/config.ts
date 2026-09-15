// Central tuning surface. Every magic number that shapes feel lives here.
import type { Rng } from './math';

export const WORLD_W = 6400;
export const WORLD_H = 4800;

/** Navigation / flow-field resolution (world units per cell). */
export const NAV = 24;
export const NAV_W = Math.ceil(WORLD_W / NAV);
export const NAV_H = Math.ceil(WORLD_H / NAV);

/** Fixed simulation timestep. */
export const SIM_HZ = 25;
export const SIM_DT = 1 / SIM_HZ;
export const MAX_STEPS_PER_FRAME = 5;

/** Axonometric constants: ground depth squash and vertical scale (~45 degrees). */
export const PITCH = 0.70;
export const ZSCALE = 0.72;

/** 1 world unit ~ 0.25 m, so an adult is ~7 units tall. */
export const HUMAN_HEIGHT = 10.4;
export const ZOMBIE_HEIGHT = 10.2;
export const BRUTE_HEIGHT = 12.6;

export const MISSION_SECONDS = 13 * 60;

export const HUMAN_START = 128;

export const CAMERA = {
  minZoom: 0.105,
  maxZoom: 9.5,
  homeZoom: 0.26,
  panSpeed: 900,
  rotSpeed: 1.7,
  keyZoomRate: 2.1,
};

export const PALETTE = {
  bg: '#101211',
  ground0: '#20221f',
  ground1: '#2a2c28',
  road: '#2b2c2a',
  roadLine: '#6f7068',
  sidewalk: '#54554e',
  park: '#333c2c',
  parkDark: '#2a3226',
  plaza: '#4a4a44',
  water: '#2a3336',
  buildingLit: 1.0,
  buildingDark: 0.52,
};

/** Human classes. Silhouette first: weapon length, shoulder mass, helmet shape. */
export type HumanClass = 'rifleman' | 'gunner' | 'breacher' | 'medic';

export interface HumanStat {
  cls: HumanClass;
  name: string;
  short: string;
  hp: number;
  speed: number;
  /** engagement range in world units (~4 units per metre) */
  range: number;
  /** optimal band */
  near: number;
  cooldown: number;
  dmgMin: number;
  dmgMax: number;
  accuracy: number;
  /** suppression radius applied to nearby humans */
  suppress: number;
  mag: number;
  spread: number;
  color: [number, number, number];
  headgear: 'helmet' | 'cap' | 'beret' | 'med';
}

export const HUMAN_STATS: Record<HumanClass, HumanStat> = {
  rifleman: { cls: 'rifleman', name: '步枪手', short: 'RIF', hp: 100, speed: 40, range: 210, near: 120, cooldown: 0.72, dmgMin: 26, dmgMax: 40, accuracy: 0.80, suppress: 0, mag: 30, spread: 1.0, color: [0.58, 0.60, 0.60], headgear: 'helmet' },
  gunner:   { cls: 'gunner',   name: '机枪手', short: 'MG',  hp: 112, speed: 31, range: 268, near: 150, cooldown: 0.13, dmgMin: 11, dmgMax: 17, accuracy: 0.62, suppress: 26, mag: 100, spread: 2.4, color: [0.50, 0.52, 0.53], headgear: 'helmet' },
  breacher: { cls: 'breacher', name: '霰弹兵', short: 'CQB', hp: 118, speed: 44, range: 92,  near: 55,  cooldown: 0.95, dmgMin: 62, dmgMax: 96, accuracy: 0.86, suppress: 0, mag: 8, spread: 5.5, color: [0.55, 0.56, 0.55], headgear: 'cap' },
  medic:    { cls: 'medic',    name: '卫生员', short: 'MED', hp: 92,  speed: 41, range: 150, near: 110, cooldown: 0.9,  dmgMin: 18, dmgMax: 26, accuracy: 0.66, suppress: 0, mag: 20, spread: 1.4, color: [0.63, 0.64, 0.62], headgear: 'med' },
};

export type ZombieClass = 'walker' | 'runner' | 'brute';

export interface ZombieStat {
  cls: ZombieClass;
  name: string;
  hp: number;
  speed: number;
  speedVar: number;
  dmg: number;
  attackRate: number;
  reach: number;
  radius: number;
  mass: number;
  clutch: number;
  color: [number, number, number];
}

export const ZOMBIE_STATS: Record<ZombieClass, ZombieStat> = {
  walker: { cls: 'walker', name: '行尸', hp: 100, speed: 26, speedVar: 0.22, dmg: 7, attackRate: 1.45, reach: 8.5, radius: 5.2, mass: 1.0, clutch: 0.35, color: [0.44, 0.47, 0.40] },
  runner: { cls: 'runner', name: '疾行者', hp: 74, speed: 62, speedVar: 0.16, dmg: 9, attackRate: 1.05, reach: 9.0, radius: 4.9, mass: 0.82, clutch: 0.10, color: [0.50, 0.44, 0.40] },
  brute:  { cls: 'brute',  name: '重躯', hp: 620, speed: 21, speedVar: 0.12, dmg: 28, attackRate: 1.9, reach: 12.5, radius: 8.6, mass: 3.4, clutch: 0.2, color: [0.38, 0.42, 0.36] },
};

export const MORALE = {
  base: 92,
  regenPeace: 2.6,
  regenRecover: 3.4,
  hitStun: 5.0,
  rout: 14,
  recover: 46,
  radius: 120,
};

export const ORDER_COLORS: Record<string, string> = {
  hold: 'rgba(240,242,238,0.92)',
  advance: 'rgba(228,214,178,0.92)',
  fallback: 'rgba(206,168,118,0.95)',
  force: 'rgba(150,196,206,0.9)',
};

export type Rng2 = Rng;
