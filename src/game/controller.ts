import { Simulation } from '../physics/simulation';
import { Device, DEVICE_LIMITS, DeviceType, DT } from '../physics/types';
import { BODY_COLORS, Level } from './level';
import { ObjectiveTracker } from './objectives';
import { computeScore, RunMetrics, ScoreBreakdown } from './scoring';

export type Phase = 'setup' | 'running' | 'paused' | 'success' | 'failed';

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; color: string; size: number;
}

export interface RunOutcome {
  success: boolean;
  metrics: RunMetrics;
  score: ScoreBreakdown | null;
  failReason: string | null;
}

export const DEVICE_COLORS: Record<DeviceType, string> = {
  attractor: '#4da3ff',
  repulsor: '#ff8a3d',
  vortex: '#b684ff',
  field: '#35e0a5',
};

const FORECAST_SECONDS = 1.6;
const TRAIL_MAX_POINTS = 1400;

/**
 * Owns one play session of a level: the player's devices, the live simulation and the
 * edit/run/result state machine. It has no knowledge of React or the canvas; the UI
 * subscribes to it and the renderer reads from it.
 */
export class GameController {
  devices: Device[] = [];
  selectedId: number | null = null;
  armed: DeviceType | null = null;
  phase: Phase = 'setup';
  sim: Simulation;
  tracker: ObjectiveTracker;
  /** Viewing speed multiplier. Only changes how many fixed steps run per frame. */
  speed = 1;
  readOnly = false;
  forecastEnabled = true;
  particlesEnabled = true;
  colors: string[] = BODY_COLORS;

  trails = new Map<string, number[]>();
  /** Trails from the previous attempt, kept as a faint reference while adjusting. */
  ghostTrails: number[][] = [];
  forecast: number[][] = [];
  particles: Particle[] = [];
  outcome: RunOutcome | null = null;
  /**
   * Compare mode: a second solution simulated in lockstep and drawn as a ghost. It is a
   * separate Simulation, so it can never influence the run being scored.
   */
  rival: { label: string; devices: Device[] } | null = null;
  rivalSim: Simulation | null = null;
  rivalTrails = new Map<string, number[]>();
  private rivalTracker: ObjectiveTracker | null = null;
  private rivalDone = false;
  /** Counts of things that happened, for statistics. */
  placedCount = 0;

  onFinish: ((outcome: RunOutcome) => void) | null = null;
  onSound: ((name: 'capture' | 'bounce' | 'bumper' | 'fail' | 'win' | 'place' | 'start', intensity: number) => void) | null = null;

  private acc = 0;
  private nextId = 1;
  private listeners = new Set<() => void>();
  version = 0;

  constructor(readonly level: Level) {
    this.sim = new Simulation(level, this.devices);
    this.tracker = new ObjectiveTracker(level, this.sim);
    this.rebuild();
  }

  // --- subscription ----------------------------------------------------------------------
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = (): number => this.version;
  private notify(): void {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  // --- devices ---------------------------------------------------------------------------
  countOf(type: DeviceType): number {
    return this.devices.filter((d) => d.type === type).length;
  }

  canPlace(type: DeviceType): boolean {
    return !this.readOnly && this.devices.length < this.level.maxDevices && this.countOf(type) < this.level.tools[type];
  }

  get selected(): Device | null {
    return this.devices.find((d) => d.id === this.selectedId) ?? null;
  }

  arm(type: DeviceType | null): void {
    if (this.readOnly) return;
    this.armed = type && this.canPlace(type) ? type : null;
    this.notify();
  }

  /** Any edit during or after a run drops back to setup so results always match the setup shown. */
  private ensureSetup(): void {
    if (this.phase !== 'setup') this.reset();
  }

  place(type: DeviceType, x: number, y: number): Device | null {
    if (!this.canPlace(type)) return null;
    this.ensureSetup();
    const L = DEVICE_LIMITS;
    const d: Device = {
      id: this.nextId++, type,
      x: clampTo(x, 0, this.level.arena.w), y: clampTo(y, 0, this.level.arena.h),
      strength: Math.min(L.strength.default, this.level.strengthCap),
      range: type === 'field' ? 130 : L.range.default,
      angle: 0, spin: 1,
    };
    this.devices.push(d);
    this.selectedId = d.id;
    this.placedCount++;
    if (!this.canPlace(type)) this.armed = null;
    this.onSound?.('place', 1);
    this.changed();
    return d;
  }

  update(id: number, patch: Partial<Device>): void {
    if (this.readOnly) return;
    const d = this.devices.find((x) => x.id === id);
    if (!d) return;
    this.ensureSetup();
    const L = DEVICE_LIMITS;
    Object.assign(d, patch);
    d.x = clampTo(d.x, 0, this.level.arena.w);
    d.y = clampTo(d.y, 0, this.level.arena.h);
    d.strength = clampTo(d.strength, L.strength.min, this.level.strengthCap);
    d.range = clampTo(d.range, L.range.min, L.range.max);
    this.changed();
  }

  remove(id: number): void {
    if (this.readOnly) return;
    this.ensureSetup();
    const i = this.devices.findIndex((d) => d.id === id);
    if (i >= 0) this.devices.splice(i, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.changed();
  }

  clearDevices(): void {
    if (this.readOnly) return;
    this.ensureSetup();
    this.devices.length = 0;
    this.selectedId = null;
    this.changed();
  }

  select(id: number | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.notify();
  }

  /** Load a saved device layout (replays). */
  loadDevices(devices: Device[]): void {
    this.devices.length = 0;
    for (const d of devices) this.devices.push({ ...d });
    this.nextId = Math.max(0, ...devices.map((d) => d.id)) + 1;
    this.selectedId = null;
    this.reset();
  }

  /** Show another solution to the same level as a ghost alongside this one. */
  setRival(label: string, devices: Device[]): void {
    this.rival = { label, devices: devices.map((d) => ({ ...d })) };
    this.reset();
  }

  private stepRival(): void {
    if (!this.rivalSim || !this.rivalTracker || this.rivalDone) return;
    this.rivalSim.step();
    if (this.rivalTracker.update() !== 'running') this.rivalDone = true;
    if (this.rivalSim.steps % 2 === 0 || this.rivalDone) {
      for (const b of this.rivalSim.bodies) {
        if (!b.active && !b.captured) continue;
        const t = this.rivalTrails.get(b.id)!;
        if (t.length >= 2 && t[t.length - 2] === b.x && t[t.length - 1] === b.y) continue;
        t.push(b.x, b.y);
      }
    }
  }

  private changed(): void {
    this.updateForecast();
    this.notify();
  }

  // --- run control -----------------------------------------------------------------------
  private rebuild(): void {
    this.sim.reset();
    this.tracker = new ObjectiveTracker(this.level, this.sim);
    this.trails.clear();
    for (const b of this.sim.bodies) this.trails.set(b.id, [b.x, b.y]);
    this.acc = 0;
    this.outcome = null;
    this.rivalSim = null;
    this.rivalTracker = null;
    this.rivalTrails.clear();
    this.rivalDone = false;
    if (this.rival) {
      this.rivalSim = new Simulation(this.level, this.rival.devices);
      this.rivalSim.collectEvents = false;
      this.rivalTracker = new ObjectiveTracker(this.level, this.rivalSim);
      for (const b of this.rivalSim.bodies) this.rivalTrails.set(b.id, [b.x, b.y]);
    }
    this.updateForecast();
  }

  start(): void {
    if (this.phase === 'running') return;
    if (this.phase === 'paused') { this.phase = 'running'; this.notify(); return; }
    if (this.phase !== 'setup') this.reset();
    this.phase = 'running';
    this.armed = null;
    this.forecast = [];
    this.onSound?.('start', 1);
    this.notify();
  }

  pause(): void {
    if (this.phase === 'running') { this.phase = 'paused'; this.notify(); }
  }

  toggleRun(): void {
    if (this.phase === 'running') this.pause();
    else this.start();
  }

  /** Back to the setup phase, keeping the player's devices. */
  reset(): void {
    if (this.phase !== 'setup' && this.sim.steps > 0) {
      this.ghostTrails = Array.from(this.trails.values()).filter((t) => t.length > 4);
    }
    this.phase = 'setup';
    this.particles.length = 0;
    this.rebuild();
    this.notify();
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.notify();
  }

  /** Advance by real elapsed time. Physics always moves in whole fixed steps. */
  tick(realDt: number): void {
    this.updateParticles(realDt);
    if (this.phase !== 'running') return;
    this.acc += Math.min(realDt, 0.1) * this.speed;
    let guard = 0;
    while (this.acc >= DT && this.phase === 'running' && guard++ < 240) {
      this.acc -= DT;
      this.sim.step();
      const state = this.tracker.update();
      if (this.sim.steps % 2 === 0) this.recordTrails();
      this.consumeEvents();
      this.stepRival();
      if (state !== 'running') {
        // Let the ghost finish its own run so its whole path is visible for comparison.
        for (let i = 0; i < 20000 && this.rivalSim && !this.rivalDone; i++) this.stepRival();
        this.finish(state === 'success');
      }
    }
  }

  private recordTrails(): void {
    for (const b of this.sim.bodies) {
      if (!b.active && !b.captured) continue;
      const t = this.trails.get(b.id)!;
      if (b.captured && t.length >= 2 && t[t.length - 2] === b.x && t[t.length - 1] === b.y) continue;
      t.push(b.x, b.y);
      if (t.length > TRAIL_MAX_POINTS * 2) t.splice(0, 2);
    }
  }

  private consumeEvents(): void {
    for (const e of this.sim.events) {
      if (e.type === 'hazard') { this.burst(e.x, e.y, '#ff4466', 26, 260); }
      else if (e.type === 'bumper') { this.burst(e.x, e.y, '#ffd166', 8, 160); this.onSound?.('bumper', 1); }
      else { if (e.intensity > 0.25) this.burst(e.x, e.y, '#9fc4ff', 4, 90); this.onSound?.('bounce', e.intensity); }
    }
    this.sim.events.length = 0;
    for (const e of this.tracker.events) {
      this.burst(e.x, e.y, this.colors[e.hue % this.colors.length], e.type === 'capture' ? 30 : 18, 220);
      this.onSound?.('capture', 1);
    }
    this.tracker.events.length = 0;
  }

  private finish(success: boolean): void {
    const metrics: RunMetrics = { time: this.tracker.finishTime, devicesUsed: this.devices.length, energy: this.sim.energy };
    this.phase = success ? 'success' : 'failed';
    this.outcome = {
      success, metrics,
      score: success ? computeScore(this.level, metrics) : null,
      failReason: this.tracker.failReason,
    };
    this.onSound?.(success ? 'win' : 'fail', 1);
    this.notify();
    this.onFinish?.(this.outcome);
  }

  // --- visuals that depend on simulation state ----------------------------------------------
  /** Short look-ahead of where each object will go, from a throwaway copy of the simulation. */
  updateForecast(): void {
    this.forecast = [];
    if (!this.forecastEnabled || this.phase !== 'setup' || this.readOnly) return;
    const sim = new Simulation(this.level, this.devices);
    sim.collectEvents = false;
    const tracker = new ObjectiveTracker(this.level, sim);
    const paths = sim.bodies.map((b) => [b.x, b.y]);
    const steps = Math.round(FORECAST_SECONDS / DT);
    for (let s = 1; s <= steps; s++) {
      sim.step();
      if (tracker.update() !== 'running') break;
      if (s % 4 === 0) sim.bodies.forEach((b, i) => { if (b.active) paths[i].push(b.x, b.y); });
    }
    this.forecast = paths.filter((p) => {
      if (p.length < 6) return false;
      return Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]) > 6 || p.length > 20;
    });
  }

  burst(x: number, y: number, color: string, count: number, speed: number): void {
    if (!this.particlesEnabled) return;
    for (let i = 0; i < count; i++) {
      // Visual-only randomness: never feeds back into the simulation.
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      const max = 0.35 + Math.random() * 0.5;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, color, size: 1.5 + Math.random() * 2.5 });
    }
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400);
  }

  private updateParticles(dt: number): void {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) { ps.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 2.5 * dt;
      p.vy *= 1 - 2.5 * dt;
    }
  }
}

function clampTo(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
