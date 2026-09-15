// Unit type registry shared by the simulation and the sprite atlas.

export const HUMAN_CLASSES = ['rifleman', 'gunner', 'breacher', 'medic'] as const;
export const ZOMBIE_CLASSES = ['walker', 'runner', 'brute'] as const;
export const ALL_TYPES = [...HUMAN_CLASSES, ...ZOMBIE_CLASSES] as const;

export type TypeName = (typeof ALL_TYPES)[number];

export const TYPE_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  ALL_TYPES.forEach((t, i) => { m[t] = i; });
  return m;
})();

export const HUMAN_TYPE_BASE = 0;
export const ZOMBIE_TYPE_BASE = HUMAN_CLASSES.length;
