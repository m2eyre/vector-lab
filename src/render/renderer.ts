import { DEVICE_COLORS, GameController } from '../game/controller';
import { netDeviceForce } from '../physics/forces';
import { gateIsOpen, hazardPosition } from '../physics/simulation';
import { Device, DEVICE_LIMITS, DeviceType } from '../physics/types';

export interface RenderOptions {
  trails: boolean;
  vectors: boolean;
  /** Seconds since page load, for ambient animation. */
  clock: number;
  reducedMotion: boolean;
  /** Ghost of a device about to be placed (world coordinates), if any. */
  hover: { x: number; y: number } | null;
  hoverDeviceId: number | null;
}

const C = {
  bg: '#070b16',
  grid: 'rgba(120,160,255,0.055)',
  gridMajor: 'rgba(120,160,255,0.11)',
  wall: '#16223c',
  wallEdge: '#3d5a94',
  hazard: '#ff3d6a',
  amber: '#ffc857',
  text: 'rgba(220,232,255,0.75)',
};

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/**
 * Draws the whole arena. Pure function of controller state + options: it never mutates
 * gameplay state, which keeps rendering and simulation fully separate.
 * The context is expected to be pre-scaled so that 1 unit = 1 world unit.
 */
export function renderArena(ctx: CanvasRenderingContext2D, c: GameController, o: RenderOptions): void {
  const { level, sim } = c;
  const W = level.arena.w;
  const H = level.arena.h;
  const t = o.reducedMotion ? 0 : o.clock;
  const simT = sim.time;

  // Background and grid ----------------------------------------------------------------
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.7);
  glow.addColorStop(0, 'rgba(40,70,140,0.22)');
  glow.addColorStop(1, 'rgba(7,11,22,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) {
    ctx.strokeStyle = x % 200 === 0 ? C.gridMajor : C.grid;
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke();
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.strokeStyle = y % 200 === 0 ? C.gridMajor : C.grid;
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
  }

  // Zones ---------------------------------------------------------------------------------
  ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
  for (const z of level.zones) {
    if (z.kind === 'gel') {
      ctx.fillStyle = 'rgba(150,230,90,0.10)';
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.save();
      ctx.beginPath(); ctx.rect(z.x, z.y, z.w, z.h); ctx.clip();
      ctx.strokeStyle = 'rgba(170,240,110,0.10)';
      ctx.lineWidth = 6;
      for (let k = -z.h; k < z.w; k += 26) { ctx.beginPath(); ctx.moveTo(z.x + k, z.y + z.h); ctx.lineTo(z.x + k + z.h, z.y); ctx.stroke(); }
      ctx.restore();
      ctx.fillStyle = 'rgba(190,245,140,0.7)';
      ctx.fillText('GEL · HIGH DRAG', z.x + 8, z.y + 18);
    } else if (z.kind === 'ice') {
      ctx.fillStyle = 'rgba(140,210,255,0.08)';
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.strokeStyle = 'rgba(160,220,255,0.25)';
      ctx.setLineDash([3, 7]);
      ctx.strokeRect(z.x + 0.5, z.y + 0.5, z.w - 1, z.h - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(180,228,255,0.7)';
      ctx.fillText('SUPERFLUID · ZERO DRAG', z.x + 8, z.y + 18);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.fillRect(z.x, z.y, z.w, z.h);
      const dirY = Math.sign(z.fy || 0);
      const dirX = Math.sign(z.fx || 0);
      ctx.strokeStyle = 'rgba(210,225,255,0.22)';
      ctx.lineWidth = 2;
      const drift = (t * 60) % 60;
      ctx.save();
      ctx.beginPath(); ctx.rect(z.x, z.y, z.w, z.h); ctx.clip();
      for (let x = z.x + 30; x < z.x + z.w; x += 50) {
        for (let y = z.y - 60; y < z.y + z.h + 60; y += 60) {
          const px = x + dirX * drift;
          const py = y + dirY * drift;
          ctx.beginPath();
          ctx.moveTo(px - 7 * Math.abs(dirY) - 7 * dirX, py - 7 * dirY - 7 * Math.abs(dirX));
          ctx.lineTo(px, py);
          ctx.lineTo(px + 7 * Math.abs(dirY) - 7 * dirX, py - 7 * dirY + 7 * Math.abs(dirX));
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(220,232,255,0.7)';
      ctx.fillText('CROSSWIND', z.x + 8, z.y + 18);
    }
  }

  // Force vectors -----------------------------------------------------------------------
  if (o.vectors && c.devices.length) drawVectorField(ctx, c, W, H);

  // Device influence areas (under everything solid) -------------------------------------
  for (const d of c.devices) drawDeviceArea(ctx, d, d.id === c.selectedId, d.id === o.hoverDeviceId, t);

  // Hazards -------------------------------------------------------------------------------
  for (const h of level.hazards) {
    const p = hazardPosition(h, simT);
    const pulse = 0.5 + 0.5 * Math.sin(t * 4 + h.x * 0.05);
    if (h.motion) {
      ctx.strokeStyle = 'rgba(255,61,106,0.25)';
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (h.motion.axis === 'x') { ctx.moveTo(h.x - h.motion.amplitude, h.y); ctx.lineTo(h.x + h.motion.amplitude, h.y); }
      else { ctx.moveTo(h.x, h.y - h.motion.amplitude); ctx.lineTo(h.x, h.y + h.motion.amplitude); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (h.shape === 'circle') {
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, h.r * 1.5);
      g.addColorStop(0, 'rgba(255,90,130,0.55)');
      g.addColorStop(0.62, 'rgba(255,61,106,0.22)');
      g.addColorStop(1, 'rgba(255,61,106,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, h.r * 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(C.hazard, 0.7 + 0.3 * pulse);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, h.r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = rgba(C.hazard, 0.35);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const k = h.r * 0.42;
      ctx.moveTo(p.x - k, p.y - k); ctx.lineTo(p.x + k, p.y + k);
      ctx.moveTo(p.x + k, p.y - k); ctx.lineTo(p.x - k, p.y + k);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255,61,106,0.22)';
      ctx.fillRect(p.x, p.y, h.w, h.h);
      ctx.strokeStyle = rgba(C.hazard, 0.7 + 0.3 * pulse);
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x, p.y, h.w, h.h);
    }
  }

  // Walls, gates and movers -----------------------------------------------------------------
  for (const w of sim.walls) {
    const def = w.def;
    if (def.motion) {
      ctx.strokeStyle = 'rgba(255,200,87,0.22)';
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const cx = def.x + def.w / 2;
      const cy = def.y + def.h / 2;
      if (def.motion.axis === 'x') { ctx.moveTo(cx - def.motion.amplitude - def.w / 2, cy); ctx.lineTo(cx + def.motion.amplitude + def.w / 2, cy); }
      else { ctx.moveTo(cx, cy - def.motion.amplitude - def.h / 2); ctx.lineTo(cx, cy + def.motion.amplitude + def.h / 2); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (def.gate) {
      const open = gateIsOpen(def.gate, simT);
      // Progress ring: fraction of the cycle until the gate next changes state.
      const u = simT / def.gate.period + def.gate.phase;
      const f = u - Math.floor(u);
      const remain = open ? (def.gate.openFraction - f) / def.gate.openFraction : (1 - f) / (1 - def.gate.openFraction);
      if (open) {
        ctx.strokeStyle = 'rgba(255,200,87,0.4)';
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(w.x + 0.5, w.y + 0.5, def.w - 1, def.h - 1);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = 'rgba(255,200,87,0.28)';
        roundRect(ctx, w.x, w.y, def.w, def.h, 4); ctx.fill();
        ctx.strokeStyle = C.amber;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const vertical = def.h >= def.w;
      ctx.fillStyle = open ? 'rgba(125,255,168,0.85)' : C.amber;
      if (vertical) ctx.fillRect(w.x + def.w + 5, w.y + def.h * (1 - remain), 3, def.h * remain);
      else ctx.fillRect(w.x, w.y + def.h + 5, def.w * remain, 3);
      continue;
    }
    ctx.fillStyle = def.motion ? '#2a2a3c' : C.wall;
    roundRect(ctx, w.x, w.y, def.w, def.h, 5);
    ctx.fill();
    ctx.strokeStyle = def.motion ? 'rgba(255,200,87,0.85)' : C.wallEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Inner bevel line for depth.
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    if (def.w > 12 && def.h > 12) { roundRect(ctx, w.x + 4, w.y + 4, def.w - 8, def.h - 8, 3); ctx.stroke(); }
  }

  // Bumpers -------------------------------------------------------------------------------
  for (const b of level.bumpers) {
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.radius);
    g.addColorStop(0, 'rgba(255,209,102,0.5)');
    g.addColorStop(1, 'rgba(255,209,102,0.1)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,209,102,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * 0.55, 0, Math.PI * 2); ctx.stroke();
  }

  // Targets -------------------------------------------------------------------------------
  for (const ts of c.tracker.targets) {
    const d = ts.def;
    const owner = d.accepts ? level.bodies.find((b) => b.id === d.accepts) : null;
    const color = owner ? c.colors[owner.hue % c.colors.length] : level.bodies.length === 1 ? c.colors[0] : '#e8f0ff';
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.6 + d.x * 0.01);
    const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.radius * 1.9);
    g.addColorStop(0, rgba(color, ts.filled ? 0.5 : 0.22));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.radius * 1.9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = ts.tooFast ? C.hazard : rgba(color, ts.filled ? 1 : 0.85);
    ctx.lineWidth = ts.filled ? 3.5 : 2.5;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2); ctx.stroke();
    if (!ts.filled) {
      ctx.strokeStyle = rgba(color, 0.35 * (1 - pulse));
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.radius * (0.35 + 0.65 * pulse), 0, Math.PI * 2); ctx.stroke();
      // Rotating docking ticks.
      ctx.strokeStyle = rgba(color, 0.8);
      ctx.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        const a = t * 0.6 + (k * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(d.x + Math.cos(a) * (d.radius + 4), d.y + Math.sin(a) * (d.radius + 4));
        ctx.lineTo(d.x + Math.cos(a) * (d.radius + 11), d.y + Math.sin(a) * (d.radius + 11));
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = rgba(color, 0.9);
      ctx.beginPath(); ctx.arc(d.x, d.y, 5, 0, Math.PI * 2); ctx.fill();
    }
    if (d.maxSpeed !== undefined && !ts.filled) {
      ctx.fillStyle = ts.tooFast ? C.hazard : C.text;
      ctx.textAlign = 'center';
      ctx.fillText(ts.tooFast ? 'TOO FAST' : `≤ ${d.maxSpeed} u/s`, d.x, d.y + d.radius + 26);
      ctx.textAlign = 'left';
    }
  }

  // Trails --------------------------------------------------------------------------------
  if (o.trails) {
    for (const g of c.ghostTrails) drawTrail(ctx, g, '#8ea3c8', 0.16, 1.5, false);
    for (const b of sim.bodies) {
      const tr = c.trails.get(b.id);
      if (tr && tr.length >= 4) drawTrail(ctx, tr, c.colors[b.def.hue % c.colors.length], 0.9, 2.2, true);
    }
  }

  // Compare ghost: the other player's generators, paths and objects -------------------------
  if (c.rival) {
    ctx.save();
    for (const d of c.rival.devices) {
      const col = DEVICE_COLORS[d.type];
      ctx.strokeStyle = rgba(col, 0.5);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 6]);
      ctx.beginPath(); ctx.arc(d.x, d.y, 15, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.45;
      drawDeviceGlyph(ctx, d.type, d.x, d.y, 0.8, col, d.angle, d.spin);
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash([7, 6]);
    for (const tr of c.rivalTrails.values()) if (tr.length >= 4) drawTrail(ctx, tr, '#ffffff', 0.5, 1.6, false);
    ctx.setLineDash([]);
    if (c.rivalSim && c.phase !== 'setup') {
      for (const b of c.rivalSim.bodies) {
        if (b.destroyed) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.radius * (b.captured ? 0.7 : 1), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Forecast ------------------------------------------------------------------------------
  if (c.forecast.length) {
    ctx.setLineDash([2, 7]);
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(232,240,255,0.55)';
    for (const p of c.forecast) {
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
  }

  // Bodies --------------------------------------------------------------------------------
  for (const b of sim.bodies) {
    const color = c.colors[b.def.hue % c.colors.length];
    if (c.phase !== 'setup') {
      // Faint marker where the object started.
      ctx.strokeStyle = rgba(color, 0.25);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.arc(b.def.x, b.def.y, b.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (b.destroyed) continue;
    const r = b.radius * (b.captured ? 0.7 : 1);
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r * 3.2);
    g.addColorStop(0, rgba(color, 0.55));
    g.addColorStop(0.4, rgba(color, 0.16));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
    const core = ctx.createRadialGradient(b.x - r * 0.35, b.y - r * 0.35, r * 0.1, b.x, b.y, r);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.45, color);
    core.addColorStop(1, rgba(color, 0.75));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
    if (b.mass > 1.5) {
      // Heavy objects get an inner ring so mass is readable at a glance.
      ctx.strokeStyle = 'rgba(7,11,22,0.55)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(b.x, b.y, r * 0.55, 0, Math.PI * 2); ctx.stroke();
    }
    if (b.inert) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -t * 12;
      ctx.beginPath(); ctx.arc(b.x, b.y, r + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    if (c.phase === 'setup' && (b.def.vx || b.def.vy)) {
      // Launch arrow for objects that start with velocity.
      drawArrow(ctx, b.x, b.y, b.x + b.def.vx * 0.3, b.y + b.def.vy * 0.3, rgba(color, 0.9), 2.5);
    }
  }

  // Devices (cores on top) ----------------------------------------------------------------
  for (const d of c.devices) drawDeviceCore(ctx, d, d.id === c.selectedId, c.readOnly, t);

  // Placement ghost -----------------------------------------------------------------------
  if (c.armed && o.hover && c.phase === 'setup') {
    const color = DEVICE_COLORS[c.armed];
    ctx.strokeStyle = rgba(color, 0.7);
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(o.hover.x, o.hover.y, c.armed === 'field' ? 22 : DEVICE_LIMITS.range.default, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = rgba(color, 0.5);
    ctx.beginPath(); ctx.arc(o.hover.x, o.hover.y, 12, 0, Math.PI * 2); ctx.fill();
  }

  // Particles -----------------------------------------------------------------------------
  for (const p of c.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawTrail(ctx: CanvasRenderingContext2D, pts: number[], color: string, alpha: number, width: number, fade: boolean): void {
  const n = pts.length / 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Draw in chunks so older parts of the trail can be dimmer than the head.
  const chunks = fade ? Math.min(12, Math.max(1, Math.floor(n / 6))) : 1;
  for (let k = 0; k < chunks; k++) {
    const a = Math.floor((k * (n - 1)) / chunks);
    const b = Math.floor(((k + 1) * (n - 1)) / chunks);
    if (b <= a) continue;
    const f = fade ? 0.25 + 0.75 * ((k + 1) / chunks) : 1;
    ctx.beginPath();
    ctx.moveTo(pts[a * 2], pts[a * 2 + 1]);
    for (let i = a + 1; i <= b; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
    if (fade) {
      ctx.strokeStyle = rgba(color, alpha * f * 0.22);
      ctx.lineWidth = width * 4;
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(color, alpha * f);
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width: number): void {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.min(9, Math.hypot(x2 - x1, y2 - y1) * 0.5);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(a - 0.45) * head, y2 - Math.sin(a - 0.45) * head);
  ctx.lineTo(x2 - Math.cos(a + 0.45) * head, y2 - Math.sin(a + 0.45) * head);
  ctx.closePath();
  ctx.fill();
}

const fv = { x: 0, y: 0 };

/** Samples the net device force on a grid and draws it as arrows (length ~ sqrt of magnitude). */
function drawVectorField(ctx: CanvasRenderingContext2D, c: GameController, W: number, H: number): void {
  const step = 40;
  for (let y = step / 2; y < H; y += step) {
    for (let x = step / 2; x < W; x += step) {
      netDeviceForce(c.devices, x, y, fv);
      const mag = Math.hypot(fv.x, fv.y);
      if (mag < 8) continue;
      const len = Math.min(17, 3 + Math.sqrt(mag) * 0.62);
      const ux = fv.x / mag;
      const uy = fv.y / mag;
      const a = Math.min(0.75, 0.18 + mag / 900);
      drawArrow(ctx, x - ux * len * 0.5, y - uy * len * 0.5, x + ux * len * 0.5, y + uy * len * 0.5, `rgba(200,220,255,${a})`, 1.2);
    }
  }
}

/** Handle position used for resizing (and rotating fields). Shared with hit-testing. */
export function handlePosition(d: Device): { x: number; y: number } {
  if (d.type === 'field') return { x: d.x + Math.cos(d.angle) * d.range, y: d.y + Math.sin(d.angle) * d.range };
  return { x: d.x + d.range * Math.SQRT1_2, y: d.y - d.range * Math.SQRT1_2 };
}

function drawDeviceArea(ctx: CanvasRenderingContext2D, d: Device, selected: boolean, hovered: boolean, t: number): void {
  const color = DEVICE_COLORS[d.type];
  const power = 0.35 + 0.65 * (d.strength / DEVICE_LIMITS.strength.max);
  if (d.type === 'field') {
    const hw = d.range * DEVICE_LIMITS.fieldAspect;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.angle);
    ctx.fillStyle = rgba(color, 0.07 + 0.07 * power);
    roundRect(ctx, -d.range, -hw, d.range * 2, hw * 2, 10);
    ctx.fill();
    ctx.strokeStyle = rgba(color, selected ? 0.95 : hovered ? 0.7 : 0.45);
    ctx.lineWidth = selected ? 2 : 1.2;
    if (selected) { ctx.setLineDash([8, 6]); ctx.lineDashOffset = -t * 14; }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    // Flowing chevrons show direction; they move faster for stronger fields.
    ctx.beginPath(); ctx.rect(-d.range, -hw, d.range * 2, hw * 2); ctx.clip();
    ctx.strokeStyle = rgba(color, 0.2 + 0.25 * power);
    ctx.lineWidth = 2;
    const spacing = 34;
    const drift = (t * (20 + 60 * power)) % spacing;
    for (let x = -d.range - spacing + drift; x < d.range + spacing; x += spacing) {
      for (let y = -hw + 18; y < hw; y += 30) {
        ctx.beginPath();
        ctx.moveTo(x - 6, y - 6); ctx.lineTo(x, y); ctx.lineTo(x - 6, y + 6);
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }
  const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.range);
  g.addColorStop(0, rgba(color, 0.1 + 0.16 * power));
  g.addColorStop(0.7, rgba(color, 0.05 + 0.05 * power));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(d.x, d.y, d.range, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = rgba(color, selected ? 0.95 : hovered ? 0.7 : 0.4);
  ctx.lineWidth = selected ? 2 : 1.2;
  if (selected) { ctx.setLineDash([8, 6]); ctx.lineDashOffset = -t * 14; }
  ctx.beginPath(); ctx.arc(d.x, d.y, d.range, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;

  // Animated rings: contracting for attractors, expanding for repulsors, spokes for vortices.
  ctx.lineWidth = 1.2;
  if (d.type === 'vortex') {
    ctx.strokeStyle = rgba(color, 0.3 + 0.3 * power);
    for (let k = 0; k < 3; k++) {
      const a0 = -d.spin * t * (0.6 + power) + (k * Math.PI * 2) / 3;
      ctx.beginPath();
      for (let s = 0; s <= 20; s++) {
        const rr = 18 + (d.range - 26) * (s / 20);
        const a = a0 + d.spin * (s / 20) * 1.4;
        const px = d.x + Math.cos(a) * rr;
        const py = d.y - Math.sin(a) * rr;
        if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  } else {
    const phase = (t * (0.25 + 0.5 * power)) % 1;
    for (let k = 0; k < 3; k++) {
      let f = (phase + k / 3) % 1;
      if (d.type === 'attractor') f = 1 - f;
      ctx.strokeStyle = rgba(color, 0.32 * (d.type === 'attractor' ? f : 1 - f));
      ctx.beginPath(); ctx.arc(d.x, d.y, 16 + (d.range - 16) * f, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

function drawDeviceCore(ctx: CanvasRenderingContext2D, d: Device, selected: boolean, readOnly: boolean, t: number): void {
  const color = DEVICE_COLORS[d.type];
  if (selected && !readOnly) {
    const h = handlePosition(d);
    if (d.type === 'field') {
      ctx.strokeStyle = rgba(color, 0.6);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(h.x, h.y); ctx.stroke();
    }
    ctx.fillStyle = '#0b1222';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(h.x, h.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = '#0b1222';
  ctx.beginPath(); ctx.arc(d.x, d.y, 15, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.stroke();
  if (selected) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(d.x, d.y, 19.5, 0, Math.PI * 2); ctx.stroke();
  }
  drawDeviceGlyph(ctx, d.type, d.x, d.y, 1, color, d.angle, d.spin);
  void t;
}

/** The small icon inside a device core; also used by the toolbar buttons. */
export function drawDeviceGlyph(ctx: CanvasRenderingContext2D, type: DeviceType, x: number, y: number, s: number, color: string, angle = 0, spin: 1 | -1 = 1): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  if (type === 'field') {
    ctx.rotate(angle);
    ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(6, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(3, -4.5); ctx.lineTo(3, 4.5); ctx.closePath(); ctx.fill();
  } else if (type === 'vortex') {
    ctx.scale(1, -spin);
    ctx.beginPath(); ctx.arc(0, 0, 6.5, -Math.PI * 0.2, Math.PI * 1.25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8.6, -4.8); ctx.lineTo(2.4, -5.4); ctx.lineTo(6.4, -0.2); ctx.closePath(); ctx.fill();
  } else {
    const inward = type === 'attractor';
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI) / 2 + Math.PI / 4);
      ctx.beginPath(); ctx.moveTo(3.5, 0); ctx.lineTo(9.5, 0); ctx.stroke();
      ctx.beginPath();
      if (inward) { ctx.moveTo(2, 0); ctx.lineTo(5.6, -2.8); ctx.lineTo(5.6, 2.8); }
      else { ctx.moveTo(11, 0); ctx.lineTo(7.4, -2.8); ctx.lineTo(7.4, 2.8); }
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}
