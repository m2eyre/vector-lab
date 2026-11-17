import { deviceForce, ForceOut } from './forces';
import {
  BodyDef, Device, DT, HazardDef, MAX_SPEED, Oscillation, PhysicsScene, SimEvent, WallDef,
} from './types';

/** Runtime state of one moving object. */
export interface Body {
  def: BodyDef;
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  mass: number;
  radius: number;
  restitution: number;
  inert: boolean;
  /** False once the body has been captured by a target or destroyed by a hazard. */
  active: boolean;
  captured: boolean;
  destroyed: boolean;
}

interface WallState {
  def: WallDef;
  x: number;
  y: number;
  vx: number;
  vy: number;
  solid: boolean;
}

/** Triangle wave in [-1, 1] with period 1. Deterministic everywhere (no trig). */
export function triangle(u: number): number {
  const f = u - Math.floor(u);
  return 4 * Math.abs(f - 0.5) - 1;
}

/** Offset and velocity of an oscillating element at time t. */
export function oscillate(m: Oscillation, t: number): { offset: number; velocity: number } {
  const u = t / m.period + m.phase;
  const f = u - Math.floor(u);
  return {
    offset: m.amplitude * triangle(u),
    velocity: ((f < 0.5 ? -4 : 4) * m.amplitude) / m.period,
  };
}

export function gateIsOpen(g: NonNullable<WallDef['gate']>, t: number): boolean {
  const u = t / g.period + g.phase;
  return u - Math.floor(u) < g.openFraction;
}

export function hazardPosition(h: HazardDef, t: number): { x: number; y: number } {
  if (!h.motion) return { x: h.x, y: h.y };
  const o = oscillate(h.motion, t).offset;
  return h.motion.axis === 'x' ? { x: h.x + o, y: h.y } : { x: h.x, y: h.y + o };
}

const WALL_FRICTION = 0.04;
const BODY_RESTITUTION = 0.92;

/**
 * Fixed-timestep 2D rigid-circle simulation.
 *
 * Integration is semi-implicit (symplectic) Euler: velocity is advanced with the current
 * acceleration first, then position with the *new* velocity. This is far more stable for
 * spring-like force fields (attractors, vortices) than explicit Euler at the same cost.
 *
 * The simulation never reads the wall clock or Math.random, so identical scenes and devices
 * always produce identical results. Rendering code only reads from it.
 */
export class Simulation {
  readonly scene: PhysicsScene;
  readonly devices: Device[];
  bodies: Body[] = [];
  walls: WallState[] = [];
  time = 0;
  steps = 0;
  /** Total |F_device| * |v| * dt summed over bodies: the work budget the devices spent. */
  energy = 0;
  /** Collision events since the consumer last cleared the list (drives particles and audio). */
  events: SimEvent[] = [];
  collectEvents = true;

  private f: ForceOut = { x: 0, y: 0 };

  constructor(scene: PhysicsScene, devices: Device[]) {
    this.scene = scene;
    this.devices = devices;
    this.reset();
  }

  reset(): void {
    this.time = 0;
    this.steps = 0;
    this.energy = 0;
    this.events.length = 0;
    this.bodies = this.scene.bodies.map((def) => ({
      def, id: def.id, x: def.x, y: def.y, vx: def.vx, vy: def.vy, ax: 0, ay: 0,
      mass: def.mass, radius: def.radius, restitution: def.restitution, inert: !!def.inert,
      active: true, captured: false, destroyed: false,
    }));
    this.walls = this.scene.walls.map((def) => ({ def, x: def.x, y: def.y, vx: 0, vy: 0, solid: true }));
    this.updateWalls();
  }

  private updateWalls(): void {
    const t = this.time;
    for (const w of this.walls) {
      const m = w.def.motion;
      if (m) {
        const o = oscillate(m, t);
        if (m.axis === 'x') { w.x = w.def.x + o.offset; w.vx = o.velocity; }
        else { w.y = w.def.y + o.offset; w.vy = o.velocity; }
      }
      if (w.def.gate) w.solid = !gateIsOpen(w.def.gate, t);
    }
  }

  /** Advance the world by exactly one fixed timestep. */
  step(): void {
    const { scene, devices, bodies } = this;
    const f = this.f;

    // 1. Forces -> acceleration -> velocity -> position (semi-implicit Euler).
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.active) continue;
      let fx = 0;
      let fy = 0;
      let devMag = 0;
      if (!b.inert) {
        for (let k = 0; k < devices.length; k++) {
          deviceForce(devices[k], b.x, b.y, f);
          fx += f.x;
          fy += f.y;
        }
        devMag = Math.sqrt(fx * fx + fy * fy);
      }
      // Environmental zones: drag overrides and constant wind forces.
      let drag = scene.drag;
      for (let k = 0; k < scene.zones.length; k++) {
        const z = scene.zones[k];
        if (b.x >= z.x && b.x <= z.x + z.w && b.y >= z.y && b.y <= z.y + z.h) {
          if (z.kind === 'wind') { fx += z.fx || 0; fy += z.fy || 0; }
          else if (z.drag !== undefined) drag = z.drag;
        }
      }
      // Newton's second law.
      b.ax = fx / b.mass;
      b.ay = fy / b.mass;
      b.vx += b.ax * DT;
      b.vy += b.ay * DT;
      // Linear drag, applied as a stable multiplicative decay.
      const decay = Math.max(0, 1 - drag * DT);
      b.vx *= decay;
      b.vy *= decay;
      const sp2 = b.vx * b.vx + b.vy * b.vy;
      if (sp2 > MAX_SPEED * MAX_SPEED) {
        const k = MAX_SPEED / Math.sqrt(sp2);
        b.vx *= k;
        b.vy *= k;
      }
      b.x += b.vx * DT;
      b.y += b.vy * DT;
      this.energy += devMag * Math.sqrt(b.vx * b.vx + b.vy * b.vy) * DT;
    }

    this.time += DT;
    this.steps++;
    this.updateWalls();

    // 2. Collision resolution. Two passes settle simultaneous contacts.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (!b.active) continue;
        this.collideBounds(b);
        for (let k = 0; k < this.walls.length; k++) {
          const w = this.walls[k];
          if (w.solid) this.collideWall(b, w);
        }
        for (let k = 0; k < scene.bumpers.length; k++) this.collideBumper(b, k);
      }
      for (let i = 0; i < bodies.length; i++) {
        if (!bodies[i].active) continue;
        for (let j = i + 1; j < bodies.length; j++) {
          if (bodies[j].active) this.collideBodies(bodies[i], bodies[j]);
        }
      }
    }

    // 3. Hazards destroy any body that touches them.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.active) continue;
      for (let k = 0; k < scene.hazards.length; k++) {
        if (this.touchesHazard(b, scene.hazards[k])) {
          b.active = false;
          b.destroyed = true;
          this.emit('hazard', b.x, b.y, 1);
          break;
        }
      }
    }
  }

  private emit(type: SimEvent['type'], x: number, y: number, intensity: number): void {
    if (this.collectEvents && this.events.length < 64) this.events.push({ type, x, y, intensity });
  }

  private collideBounds(b: Body): void {
    const { w, h } = this.scene.arena;
    const e = b.restitution;
    let hit = 0;
    if (b.x < b.radius) { b.x = b.radius; if (b.vx < 0) { hit = -b.vx; b.vx = -b.vx * e; } }
    else if (b.x > w - b.radius) { b.x = w - b.radius; if (b.vx > 0) { hit = b.vx; b.vx = -b.vx * e; } }
    if (b.y < b.radius) { b.y = b.radius; if (b.vy < 0) { hit = Math.max(hit, -b.vy); b.vy = -b.vy * e; } }
    else if (b.y > h - b.radius) { b.y = h - b.radius; if (b.vy > 0) { hit = Math.max(hit, b.vy); b.vy = -b.vy * e; } }
    if (hit > 40) this.emit('wall', b.x, b.y, Math.min(1, hit / 500));
  }

  /** Circle vs axis-aligned box, accounting for the wall's own velocity when it moves. */
  private collideWall(b: Body, w: WallState): void {
    const cx = Math.max(w.x, Math.min(b.x, w.x + w.def.w));
    const cy = Math.max(w.y, Math.min(b.y, w.y + w.def.h));
    let dx = b.x - cx;
    let dy = b.y - cy;
    let distSq = dx * dx + dy * dy;
    if (distSq >= b.radius * b.radius) return;
    let nx: number;
    let ny: number;
    let pen: number;
    if (distSq > 1e-9) {
      const dist = Math.sqrt(distSq);
      nx = dx / dist;
      ny = dy / dist;
      pen = b.radius - dist;
    } else {
      // Centre is inside the box (e.g. a gate closed on it): eject along the shallowest axis.
      const left = b.x - w.x;
      const right = w.x + w.def.w - b.x;
      const top = b.y - w.y;
      const bottom = w.y + w.def.h - b.y;
      const m = Math.min(left, right, top, bottom);
      nx = 0; ny = 0;
      if (m === left) nx = -1; else if (m === right) nx = 1; else if (m === top) ny = -1; else ny = 1;
      pen = m + b.radius;
    }
    b.x += nx * pen;
    b.y += ny * pen;
    // Reflect the velocity relative to the wall about the contact normal.
    const rvx = b.vx - w.vx;
    const rvy = b.vy - w.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      const j = -(1 + b.restitution) * vn;
      b.vx += nx * j;
      b.vy += ny * j;
      // A little tangential friction so objects don't slide along walls forever.
      const tx = -ny;
      const ty = nx;
      const vt = (b.vx - w.vx) * tx + (b.vy - w.vy) * ty;
      b.vx -= tx * vt * WALL_FRICTION;
      b.vy -= ty * vt * WALL_FRICTION;
      if (-vn > 40) this.emit('wall', cx, cy, Math.min(1, -vn / 500));
    }
  }

  private collideBumper(b: Body, index: number): void {
    const bp = this.scene.bumpers[index];
    const dx = b.x - bp.x;
    const dy = b.y - bp.y;
    const minDist = b.radius + bp.radius;
    const distSq = dx * dx + dy * dy;
    if (distSq >= minDist * minDist) return;
    const dist = Math.sqrt(distSq) || 1e-6;
    const nx = dx / dist;
    const ny = dy / dist;
    b.x = bp.x + nx * minDist;
    b.y = bp.y + ny * minDist;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      // Perfectly elastic bounce plus an active kick along the normal.
      b.vx += nx * (-2 * vn + bp.kick);
      b.vy += ny * (-2 * vn + bp.kick);
      this.emit('bumper', bp.x + nx * bp.radius, bp.y + ny * bp.radius, 1);
    }
  }

  /** Impulse-based collision between two circles with different masses. */
  private collideBodies(a: Body, b: Body): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const minDist = a.radius + b.radius;
    const distSq = dx * dx + dy * dy;
    if (distSq >= minDist * minDist) return;
    const dist = Math.sqrt(distSq) || 1e-6;
    const nx = dx / dist;
    const ny = dy / dist;
    const invA = 1 / a.mass;
    const invB = 1 / b.mass;
    // Positional correction, shared in proportion to inverse mass.
    const pen = minDist - dist;
    const corr = pen / (invA + invB);
    a.x -= nx * corr * invA;
    a.y -= ny * corr * invA;
    b.x += nx * corr * invB;
    b.y += ny * corr * invB;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < 0) {
      // j = -(1 + e) * v_rel.n / (1/ma + 1/mb) conserves momentum exactly.
      const j = (-(1 + BODY_RESTITUTION) * vn) / (invA + invB);
      a.vx -= nx * j * invA;
      a.vy -= ny * j * invA;
      b.vx += nx * j * invB;
      b.vy += ny * j * invB;
      if (-vn > 30) this.emit('body', a.x + nx * a.radius, a.y + ny * a.radius, Math.min(1, -vn / 400));
    }
  }

  private touchesHazard(b: Body, h: HazardDef): boolean {
    const p = hazardPosition(h, this.time);
    // Hazards are slightly forgiving: only 70% of the body's radius counts.
    const r = b.radius * 0.7;
    if (h.shape === 'circle') {
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const lim = r + h.r;
      return dx * dx + dy * dy < lim * lim;
    }
    const cx = Math.max(p.x, Math.min(b.x, p.x + h.w));
    const cy = Math.max(p.y, Math.min(b.y, p.y + h.h));
    const dx = b.x - cx;
    const dy = b.y - cy;
    return dx * dx + dy * dy < r * r;
  }
}
