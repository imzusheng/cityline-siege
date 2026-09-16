// The line-order system. A drawn stroke becomes a ranked formation whose slots
// survive casualties: when a soldier dies the slot frees and the nearest
// unengaged comrade flows into it, so a line heals its own gaps.

import { clamp, TAU } from '../core/math';
import type { Human, OrderKind, World } from './world';

export interface Slot {
  x: number; y: number;
  taken: number;
  rank: number;
  jx: number;
  jy: number;
}

export interface LineOrder {
  id: number;
  kind: OrderKind;
  ax: number; ay: number;
  bx: number; by: number;
  dirX: number; dirY: number;
  frontX: number; frontY: number;
  len: number;
  slots: Slot[];
  created: number;
  refit: number;
  advanceSpeed: number;
  active: boolean;
  label: string;
  /** one-line explanation shown with the order toast */
  detail: string;
}

const ROLE_RANK: Record<string, number> = { breacher: 0, rifleman: 1, gunner: 2, medic: 3 };

export function orderLabel(kind: OrderKind): string {
  switch (kind) {
    case 'hold': return '守住阵线';
    case 'advance': return '推进';
    case 'fallback': return '后撤重整';
    case 'force': return '强行军';
    case 'move': return '移动';
    default: return '待命';
  }
}

export function orderDetail(kind: OrderKind): string {
  switch (kind) {
    case 'hold': return '到位后据守，朝向最近的感染体';
    case 'advance': return '边打边推进，接触时减速';
    case 'fallback': return '脱离接触，重新组织';
    case 'force': return '持续行军，被完全挡住才停下';
    case 'move': return '移动到指定位置';
    default: return '';
  }
}

export function clearOrder(h: Human): void {
  h.orderId = 0;
  h.slotIndex = -1;
}

export function issueOrder(
  world: World, units: Human[], kind: OrderKind,
  ax: number, ay: number, bx: number, by: number,
): LineOrder | null {
  const list = units.filter(u => u.alive);
  if (!list.length) return null;
  const dx = bx - ax, dy = by - ay;
  let len = Math.hypot(dx, dy);
  let ux: number, uy: number;
  if (len < 24) {
    // a tap becomes a loose cluster order around the point
    ux = 1; uy = 0; len = 0;
  } else { ux = dx / len; uy = dy / len; }

  // centroid of the ordered troops
  let cx = 0, cy = 0;
  for (const u of list) { cx += u.x; cy += u.y; }
  cx /= list.length; cy /= list.length;

  // which way is "front" (the enemy)? fall back to the movement direction.
  let fx = 0, fy = 0, n = 0;
  const midX = len > 0 ? (ax + bx) * 0.5 : bx;
  const midY = len > 0 ? (ay + by) * 0.5 : by;
  world.hashZ.forEachNear(midX, midY, 720, (i) => {
    const z = world.zombies[i];
    if (!z || !z.alive) return;
    const ddx = z.x - midX, ddy = z.y - midY;
    const d = Math.hypot(ddx, ddy) || 1;
    fx += ddx / d; fy += ddy / d; n++;
  });
  if (n < 3) { fx = midX - cx; fy = midY - cy; }
  let fl = Math.hypot(fx, fy);
  if (fl < 0.001) { fx = -uy; fy = ux; fl = 1; }
  fx /= fl; fy /= fl;
  if (len > 24) {
    // snap the front to the line normal so ranks stay parallel
    const nx = -uy, ny = ux;
    const dot = fx * nx + fy * ny;
    if (Math.abs(dot) > 0.12) { fx = nx * Math.sign(dot); fy = ny * Math.sign(dot); }
    else { fx = midX - cx; fy = midY - cy; const l = Math.hypot(fx, fy) || 1; fx /= l; fy /= l; }
  }

  const loose = kind === 'force' || kind === 'fallback';
  const spacing = loose ? 19 : 12.6;
  const depth = loose ? 20 : 13.5;
  const cap = len > 24 ? Math.max(2, Math.floor(len / spacing) + 1) : Math.max(3, Math.ceil(Math.sqrt(list.length) * 1.5));
  const ranks = Math.max(1, Math.ceil(list.length / cap));

  const slots: Slot[] = [];
  const bx2 = len > 24 ? 0 : -depth * (Math.sqrt(list.length) * 0.5);
  for (let r = 0; r < ranks; r++) {
    const count = Math.min(cap, list.length - r * cap > 0 ? cap : 0);
    if (count <= 0) break;
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? (i + 0.5) / count : 0.5;
      let px: number, py: number;
      if (len > 24) {
        px = ax + dx * t - fx * depth * r;
        py = ay + dy * t - fy * depth * r;
      } else {
        const a = (i / Math.max(1, count)) * TAU + r * 0.7;
        const rad = 14 + r * 15;
        px = bx + Math.cos(a) * rad;
        py = by + Math.sin(a) * rad;
      }
      const jx = (Math.sin(i * 12.9898 + r * 78.233) * 43758.5453 % 1) * spacing * 0.22;
      const jy = (Math.sin(i * 39.3468 + r * 11.135) * 24634.6345 % 1) * depth * 0.28;
      slots.push({ x: px, y: py, taken: -1, rank: r, jx, jy });
    }
  }
  void bx2;

  // ---- assign troops: front rank first, ordered along the stroke
  const proj = new Map<Human, number>();
  for (const u of list) {
    const t = len > 24 ? ((u.x - ax) * ux + (u.y - ay) * uy) / len : ((u.x - cx) * ux + (u.y - cy) * uy);
    proj.set(u, t);
  }
  list.sort((a, b) => {
    const ra = ROLE_RANK[a.cls] ?? 1, rb = ROLE_RANK[b.cls] ?? 1;
    if (ra !== rb) return ra - rb;
    return (proj.get(a) ?? 0) - (proj.get(b) ?? 0);
  });

  const order: LineOrder = {
    id: world.orderSeq++,
    kind, ax, ay, bx, by, dirX: ux, dirY: uy,
    frontX: fx, frontY: fy, len,
    slots, created: world.state.time, refit: 0.6,
    advanceSpeed: 0, active: true,
    label: orderLabel(kind),
    detail: orderDetail(kind),
  };
  world.orders.set(order.id, order);

  for (const u of list) {
    clearOrder(u);
    u.orderId = order.id;
  }
  for (let i = 0; i < list.length && i < slots.length; i++) {
    const u = list[i]!;
    u.slotIndex = i;
    slots[i]!.taken = world.humans.indexOf(u);
  }
  applyOrderState(list, kind);
  return order;
}

export function applyOrderState(units: Human[], kind: OrderKind): void {
  for (const u of units) {
    switch (kind) {
      case 'hold': u.state = 'DEPLOY'; break;
      case 'advance': u.state = 'DEPLOY'; break;
      case 'fallback': u.state = 'RETREAT'; break;
      case 'force': u.state = 'MOVE'; break;
      case 'move': u.state = 'MOVE'; break;
      default: break;
    }
  }
}

export function orderSlotPos(order: LineOrder, index: number, out: { x: number; y: number }): void {
  const s = order.slots[index];
  if (!s) { out.x = order.bx; out.y = order.by; return; }
  out.x = s.x; out.y = s.y;
}

/**
 * Free dead slots and let the nearest unengaged comrade flow into them.
 * This is what makes a thinning line look like it is mending itself.
 */
export function refitOrder(world: World, order: LineOrder, dt: number): void {
  order.refit -= dt;
  if (order.refit > 0) return;
  order.refit = 0.75;
  const slots = order.slots;
  const humans = world.humans;
  const owner = new Int32Array(slots.length).fill(-1);
  const claimed = new Uint8Array(humans.length);
  for (let i = 0; i < humans.length; i++) {
    const h = humans[i]!;
    if (!h.alive || h.orderId !== order.id) continue;
    const si = h.slotIndex;
    if (si >= 0 && si < slots.length && owner[si]! < 0) { owner[si] = i; claimed[i] = 1; }
    else h.slotIndex = -1;
  }
  for (let si = 0; si < slots.length; si++) {
    if (owner[si]! >= 0) { slots[si]!.taken = owner[si]!; continue; }
    let best = -1, bd = 1e9;
    for (let i = 0; i < humans.length; i++) {
      const h = humans[i]!;
      if (!h.alive || h.orderId !== order.id || claimed[i]) continue;
      if (h.state === 'ENGAGE' || h.state === 'ROUT') continue;
      const dx = h.x - slots[si]!.x, dy = h.y - slots[si]!.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = i; }
    }
    if (best >= 0 && bd < 320 * 320) {
      owner[si] = best;
      claimed[best] = 1;
      slots[si]!.taken = best;
      humans[best]!.slotIndex = si;
    } else {
      slots[si]!.taken = -1;
    }
  }
}

/** March an advancing line forward along its facing. */
export function advanceOrder(order: LineOrder, dt: number, hasContact: boolean): void {
  if (order.kind !== 'advance') return;
  const target = hasContact ? 13 : 34;
  order.advanceSpeed += (target - order.advanceSpeed) * Math.min(1, dt * 1.6);
  const step = order.advanceSpeed * dt;
  if (step <= 0) return;
  for (const s of order.slots) {
    s.x += order.frontX * step;
    s.y += order.frontY * step;
  }
  order.ax += order.frontX * step;
  order.ay += order.frontY * step;
  order.bx += order.frontX * step;
  order.by += order.frontY * step;
}

export function countOrderMembers(world: World, orderId: number): number {
  let n = 0;
  for (const h of world.humans) if (h.alive && h.orderId === orderId) n++;
  return n;
}

export function clampWorld(x: number, y: number): { x: number; y: number } {
  const W = 6400, H = 4800;
  return { x: clamp(x, 10, W - 10), y: clamp(y, 10, H - 10) };
}
