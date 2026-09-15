// HUD: a deliberately thin DOM layer plus a 2D overlay for everything that
// belongs in the world (selected units, drawn lines, danger markers).

import { clamp } from '../core/math';
import { MISSION_SECONDS, PITCH } from '../core/config';
import type { Camera } from '../renderer/camera';
import type { World, Human } from '../simulation/world';
import { humanStateLabel } from '../simulation/world';
import { orderLabel, type LineOrder } from '../simulation/orders';
import type { Tool } from '../input/input';

function el<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

export interface DangerMark { x: number; y: number; label: string; level: number; t: number; }

export class Hud {
  private sHumans = el('s-humans');
  private sZombies = el('s-zombies');
  private sLosses = el('s-losses');
  private sTime = el('s-time');
  private sFps = el('s-fps');
  private sUnits = el('s-units');
  private sCam = el('s-cam');
  private objBlock = el('obj-block');
  private toasts = el('toasts');
  private selPanel = el('sel-panel');
  private selTitle = el('sel-title');
  private selN = el('sel-n');
  private selMorale = el('sel-morale');
  private selMoraleV = el('sel-morale-v');
  private selState = el('sel-state');
  private selComp = el('sel-comp');
  private hintbar = el('hintbar');
  private splash = el('splash');
  private result = el('result');
  private resultTitle = el('result-title');
  private resultKicker = el('result-kicker');
  private resultCopy = el('result-copy');
  private resultStats = el('result-stats');
  private loadLine = el('load-line');
  private startBtn = el<HTMLButtonElement>('btn-start');
  private toolButtons: HTMLButtonElement[];
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private dangers: DangerMark[] = [];
  private objThreat: number[] = [0, 0, 0];
  private time = 0;
  private districtClock = 0;
  private objEls: HTMLElement[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]'));
  }

  setLoading(text: string): void { this.loadLine.textContent = text; }
  enableStart(v: boolean): void { this.startBtn.disabled = !v; }
  hideSplash(): void { this.splash.classList.add('hidden'); }
  showSplash(): void { this.splash.classList.remove('hidden'); }

  buildObjectives(world: World): void {
    this.objBlock.innerHTML = '';
    this.objEls = [];
    for (const o of world.city.objectives) {
      const d = document.createElement('div');
      d.className = 'obj';
      d.innerHTML = `<label>${o.name}</label><div class="bar"><i style="width:100%"></i></div>`;
      this.objBlock.appendChild(d);
      this.objEls.push(d);
    }
  }

  setToolActive(tool: Tool): void {
    for (const b of this.toolButtons) b.classList.toggle('active', b.dataset.tool === tool);
  }

  toast(title: string, detail = '', kind: 'info' | 'warn' | 'danger' = 'info'): void {
    const d = document.createElement('div');
    d.className = 'toast' + (kind === 'danger' ? ' danger' : kind === 'warn' ? ' warn' : '');
    d.innerHTML = `${title}${detail ? `<small>${detail}</small>` : ''}`;
    this.toasts.appendChild(d);
    requestAnimationFrame(() => d.classList.add('on'));
    setTimeout(() => { d.classList.remove('on'); setTimeout(() => d.remove(), 400); }, 4200);
    while (this.toasts.children.length > 4) this.toasts.removeChild(this.toasts.firstChild!);
  }

  showResult(win: boolean, world: World): void {
    this.result.classList.remove('hidden');
    this.resultTitle.textContent = win ? '撤离完成' : '城市核心失守';
    this.resultKicker.textContent = win ? 'CITY HELD' : 'LINE COLLAPSED';
    this.resultCopy.textContent = win
      ? '城市撑过了这一轮围城。牺牲了很多街区，但核心区仍在运转。'
      : '感染体穿过了最后一道防线。更早地收缩战线，往往比死守每一条街更有效。';
    const alive = world.humanAlive;
    this.resultStats.innerHTML = [
      `<div><b>${alive}</b>幸存守军</div>`,
      `<div><b>${world.state.kills}</b>击杀感染体</div>`,
      `<div><b>${world.state.losses}</b>守军阵亡</div>`,
      `<div><b>${Math.round(world.state.objectiveHp)}%</b>核心完整度</div>`,
    ].join('');
  }

  hideResult(): void { this.result.classList.add('hidden'); }

  resize(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(world: World, camera: Camera, fps: number, dt: number): void {
    const st = world.state;
    this.sHumans.textContent = String(world.humanAlive);
    this.sZombies.textContent = world.zombieAlive.toLocaleString();
    this.sLosses.textContent = String(st.losses);
    const t = Math.floor(st.time);
    this.sTime.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    this.sFps.textContent = String(Math.round(fps));
    this.sUnits.textContent = String(world.humanAlive + world.zombieAlive);
    this.sCam.textContent = `${camera.zoom.toFixed(2)}x ${Math.round(((camera.rot * 180 / Math.PI) % 360 + 360) % 360)}°`;

    for (let i = 0; i < world.city.objectives.length; i++) {
      const o = world.city.objectives[i]!;
      const node = this.objEls[i];
      if (!node) continue;
      node.classList.toggle('lost', o.lost);
      node.classList.toggle('hurt', !o.lost && o.hp < 60);
      const bar = node.querySelector('i') as HTMLElement;
      bar.style.width = Math.max(0, o.hp) + '%';
    }

    this.updateSelection(world);
    this.updateDangers(world, dt);
    this.updateHint(world);
    void MISSION_SECONDS;
  }

  private updateSelection(world: World): void {
    let n = 0, morale = 0, hp = 0;
    const comp: Record<string, number> = { rifleman: 0, gunner: 0, breacher: 0, medic: 0 };
    const states: Record<string, number> = {};
    for (const h of world.humans) {
      if (!h.alive || !h.selected) continue;
      n++;
      morale += h.morale;
      hp += h.hp;
      comp[h.cls] = (comp[h.cls] ?? 0) + 1;
      states[h.state] = (states[h.state] ?? 0) + 1;
    }
    if (!n) {
      this.selPanel.classList.add('hidden');
      return;
    }
    this.selPanel.classList.remove('hidden');
    morale /= n; hp /= n;
    this.selTitle.textContent = '已选部队';
    this.selN.textContent = n + ' 人';
    this.selMorale.style.width = clamp(morale, 0, 100) + '%';
    this.selMorale.style.background = morale < 35 ? 'var(--danger)' : morale < 60 ? 'var(--warn)' : 'var(--ok)';
    this.selMoraleV.textContent = Math.round(morale) + '%';
    let bestState = 'HOLD', bestN = -1;
    for (const k of Object.keys(states)) if (states[k]! > bestN) { bestN = states[k]!; bestState = k; }
    this.selState.textContent = humanStateLabel(bestState as Human['state']);
    this.selComp.textContent = `步枪 ${comp.rifleman} · 机枪 ${comp.gunner} · 近战 ${comp.breacher} · 医护 ${comp.medic}`;
    void hp;
  }

  private updateHint(world: World): void {
    let selected = 0;
    for (const h of world.humans) if (h.alive && h.selected) selected++;
    let text = '';
    if (world.state.time < 12) text = '按住左键框选士兵，然后按 2 画出一条阵线';
    else if (selected === 0) text = '框选部队以发出命令';
    this.hintbar.textContent = text;
    this.hintbar.classList.toggle('on', !!text);
  }

  private updateDangers(world: World, dt: number): void {
    this.districtClock -= dt;
    if (this.districtClock <= 0) {
      this.districtClock = 0.8;
      this.dangers.length = 0;
      for (const d of world.city.districts) {
        let z = 0, hh = 0;
        const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
        for (const u of world.zombies) {
          if (!u.alive) continue;
          if (u.x >= d.x && u.x < d.x + d.w && u.y >= d.y && u.y < d.y + d.h) z++;
        }
        for (const u of world.humans) {
          if (!u.alive) continue;
          if (u.x >= d.x && u.x < d.x + d.w && u.y >= d.y && u.y < d.y + d.h) hh++;
        }
        if (z > 45 && z > hh * 2.6) {
          this.dangers.push({ x: cx, y: cy, label: d.name, level: Math.min(1, z / 320), t: 0 });
        }
      }
      for (let i = 0; i < world.city.objectives.length; i++) {
        const o = world.city.objectives[i]!;
        let n = 0;
        for (const u of world.zombies) {
          if (!u.alive) continue;
          if ((u.x - o.x) ** 2 + (u.y - o.y) ** 2 < (o.r + 90) ** 2) n++;
        }
        this.objThreat[i] = Math.min(1, n / 45);
      }
      this.dangers.sort((a, b) => b.level - a.level);
      this.dangers.length = Math.min(3, this.dangers.length);
    }
    for (const d of this.dangers) d.t += dt;
    this.time += dt;
  }

  /** Everything drawn in world space on top of the GL frame. */
  drawOverlay(world: World, camera: Camera, preview: { ax: number; ay: number; bx: number; by: number; tool: Tool } | null, rect: { x0: number; y0: number; x1: number; y1: number } | null): void {
    const ctx = this.ctx;
    const W = camera.W, H = camera.H;
    ctx.clearRect(0, 0, W, H);

    // Objective markers. The zone itself is painted into the ground texture,
    // so the overlay only adds a small grounded pin plus a hazard halo while
    // the node is actually under attack (never an idle floating circle).
    for (let i = 0; i < world.city.objectives.length; i++) {
      const o = world.city.objectives[i]!;
      const p = camera.worldToScreen(o.x, o.y);
      const rx = o.r * camera.zoom;
      const ry = o.r * PITCH * camera.zoom;
      if (p.x < -rx * 2 || p.x > W + rx * 2 || p.y < -ry * 2 || p.y > H + ry * 2) continue;
      const threat = this.objThreat[i] ?? 0;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 3.4 + i);
      ctx.save();
      if (o.lost || threat > 0.25) {
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = o.lost
          ? `rgba(150,52,46,${(0.10 + 0.05 * pulse).toFixed(3)})`
          : `rgba(190,142,70,${(0.05 + 0.07 * threat + 0.04 * pulse).toFixed(3)})`;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = o.lost ? 'rgba(200,86,79,0.55)' : `rgba(206,168,95,${(0.30 + 0.3 * threat).toFixed(2)})`;
        ctx.setLineDash([5, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // grounded pin: a chevron that sits on the marker point
      const hi = 15 + (o.lost ? 0 : pulse * 2.5);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - 5.5, p.y - 9);
      ctx.lineTo(p.x - 2, p.y - 9);
      ctx.lineTo(p.x - 2, p.y - hi);
      ctx.lineTo(p.x + 2, p.y - hi);
      ctx.lineTo(p.x + 2, p.y - 9);
      ctx.lineTo(p.x + 5.5, p.y - 9);
      ctx.closePath();
      ctx.fillStyle = o.lost ? 'rgba(200,86,79,0.9)' : 'rgba(236,238,234,0.85)';
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 3.4, 1.8, 0, 0, Math.PI * 2);
      ctx.fillStyle = o.lost ? 'rgba(200,86,79,0.85)' : 'rgba(236,238,234,0.7)';
      ctx.fill();
      ctx.font = '600 9.5px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = o.lost ? 'rgba(214,140,132,0.95)' : 'rgba(228,232,226,0.85)';
      ctx.fillText(o.name, p.x, p.y - hi - 6);
      if (!o.lost && o.hp < 99) {
        ctx.font = '9px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(200,204,198,0.7)';
        ctx.fillText(Math.round(o.hp) + '%', p.x, p.y + 12);
      }
      ctx.restore();
    }

    // selected soldier markers
    if (camera.zoom > 0.16) {
      ctx.save();
      ctx.strokeStyle = 'rgba(240,242,238,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const h of world.humans) {
        if (!h.alive || !h.selected) continue;
        const p = camera.worldToScreen(h.x, h.y);
        if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
        const r = Math.max(4, 2.6 * Math.min(3, camera.zoom * 1.6));
        ctx.moveTo(p.x + r, p.y);
        ctx.ellipse(p.x, p.y, r, r * 0.55, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.restore();
    }

    // recent command lines
    ctx.save();
    ctx.lineCap = 'round';
    for (const o of world.orders.values()) this.drawOrder(ctx, camera, o, 0.5);
    ctx.restore();

    // live preview
    if (preview) {
      const a = camera.worldToScreen(preview.ax, preview.ay);
      const b = camera.worldToScreen(preview.bx, preview.by);
      const color = preview.tool === 'fallback' ? 'rgba(206,168,118,0.95)'
        : preview.tool === 'force' ? 'rgba(150,196,206,0.9)'
        : preview.tool === 'advance' ? 'rgba(228,214,178,0.95)' : 'rgba(244,245,242,0.95)';
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      if (preview.tool === 'fallback') ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      // perpendicular ticks show the facing of the line
      const dx = b.x - a.x, dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const px = a.x + dx * t, py = a.y + dy * t;
        ctx.moveTo(px, py); ctx.lineTo(px - uy * 9, py + ux * 9);
      }
      ctx.stroke();
      ctx.restore();
    }

    // danger markers
    for (const d of this.dangers) {
      const p = camera.worldToScreen(d.x, d.y);
      if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) continue;
      const pulse = 0.55 + 0.45 * Math.sin(d.t * 4.2);
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.4 * pulse;
      ctx.strokeStyle = 'rgba(200,86,79,0.95)';
      ctx.lineWidth = 1.6;
      const s = 11 + pulse * 3;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - s);
      ctx.lineTo(p.x + s, p.y + s * 0.72);
      ctx.lineTo(p.x - s, p.y + s * 0.72);
      ctx.closePath();
      ctx.stroke();
      ctx.font = '9px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(214,140,132,0.95)';
      ctx.textAlign = 'center';
      ctx.fillText(`${d.label} 告急`, p.x, p.y + s * 0.72 + 12);
      ctx.restore();
    }

    // selection rectangle
    if (rect) {
      const x = Math.min(rect.x0, rect.x1), y = Math.min(rect.y0, rect.y1);
      const w = Math.abs(rect.x1 - rect.x0), h = Math.abs(rect.y1 - rect.y0);
      ctx.save();
      ctx.fillStyle = 'rgba(240,242,238,0.06)';
      ctx.strokeStyle = 'rgba(240,242,238,0.68)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.restore();
    }
  }

  private drawOrder(ctx: CanvasRenderingContext2D, camera: Camera, o: LineOrder, alpha: number): void {
    if (o.len <= 24) return;
    const a = camera.worldToScreen(o.ax, o.ay);
    const b = camera.worldToScreen(o.bx, o.by);
    const W = camera.W, H = camera.H;
    if ((a.x < -200 && b.x < -200) || (a.x > W + 200 && b.x > W + 200)) return;
    if ((a.y < -200 && b.y < -200) || (a.y > H + 200 && b.y > H + 200)) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = o.kind === 'fallback' ? 'rgba(206,168,118,0.9)'
      : o.kind === 'force' ? 'rgba(150,196,206,0.75)'
      : o.kind === 'advance' ? 'rgba(228,214,178,0.8)' : 'rgba(236,238,235,0.75)';
    ctx.lineWidth = 1.25;
    ctx.setLineDash(o.kind === 'fallback' ? [7, 6] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
    void orderLabel;
  }
}

export { MISSION_SECONDS };
