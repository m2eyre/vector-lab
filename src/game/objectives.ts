import { Body, Simulation } from '../physics/simulation';
import { Level, TargetDef } from './level';

export type RunState = 'running' | 'success' | 'failed';
export type FailReason = 'hazard' | 'timeout' | 'sync' | 'stalled';

export interface TargetState {
  def: TargetDef;
  /** deliver/sync: a body is docked here. collect: the target has been swept. */
  filled: boolean;
  filledAt: number;
  /** True while a body is inside but moving too fast to be captured. */
  tooFast: boolean;
}

export interface ObjectiveEvent {
  type: 'capture' | 'collect';
  x: number;
  y: number;
  hue: number;
}

/**
 * Watches a simulation and decides when the level's objective is met or failed.
 * It is game logic layered on top of the physics: the engine itself knows nothing about targets.
 */
export class ObjectiveTracker {
  state: RunState = 'running';
  failReason: FailReason | null = null;
  /** Simulated time at which the run finished. */
  finishTime = 0;
  targets: TargetState[];
  events: ObjectiveEvent[] = [];
  firstCaptureAt = -1;
  lastCaptureAt = -1;
  /** Closest each required body has come to an eligible target (drives the solver's fitness). */
  private minDist = new Map<string, number>();
  private stillSteps = 0;
  /** Levels with moving parts can change on their own, so they never count as stalled. */
  private canStall: boolean;

  constructor(readonly level: Level, readonly sim: Simulation) {
    this.targets = level.targets.map((def) => ({ def, filled: false, filledAt: -1, tooFast: false }));
    for (const id of level.objective.required) this.minDist.set(id, Infinity);
    this.canStall = level.objective.type !== 'survive' && !level.walls.some((w) => w.motion || w.gate) && !level.hazards.some((h) => h.motion);
  }

  get capturedCount(): number {
    const o = this.level.objective;
    if (o.type === 'collect') return this.targets.filter((t) => t.filled).length;
    return this.sim.bodies.filter((b) => b.captured && o.required.includes(b.id)).length;
  }

  get totalCount(): number {
    const o = this.level.objective;
    return o.type === 'collect' ? this.targets.length : o.required.length;
  }

  /** Call once after every physics step. */
  update(): RunState {
    if (this.state !== 'running') return this.state;
    const { sim, level } = this;
    const o = level.objective;
    const required = o.required;

    for (const t of this.targets) t.tooFast = false;

    for (const b of sim.bodies) {
      if (!b.active) continue;
      const isRequired = required.includes(b.id);
      let best = Infinity;
      for (const t of this.targets) {
        if (t.filled) continue;
        if (t.def.accepts && t.def.accepts !== b.id) continue;
        if (!isRequired) continue;
        const dx = b.x - t.def.x;
        const dy = b.y - t.def.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < best) best = dist;
        if (dist > t.def.radius) continue;
        if (t.def.maxSpeed !== undefined && b.vx * b.vx + b.vy * b.vy > t.def.maxSpeed * t.def.maxSpeed) {
          t.tooFast = true;
          continue;
        }
        t.filled = true;
        t.filledAt = sim.time;
        if (o.type === 'collect') {
          this.events.push({ type: 'collect', x: t.def.x, y: t.def.y, hue: b.def.hue });
          // The sweep distance restarts for the next target.
          this.minDist.set(b.id, Infinity);
          best = Infinity;
        } else {
          this.capture(b, t);
          break;
        }
      }
      if (isRequired && b.active && best < (this.minDist.get(b.id) ?? Infinity)) this.minDist.set(b.id, best);
    }

    // Failure checks.
    if (sim.bodies.some((b) => b.destroyed)) return this.finish('failed', 'hazard');

    // Success checks.
    if (o.type === 'survive') {
      if (sim.time >= (o.duration ?? 10)) return this.finish('success', null);
    } else if (this.capturedCount >= this.totalCount) {
      return this.finish('success', null);
    }

    if (o.type === 'sync' && this.firstCaptureAt >= 0 && sim.time - this.firstCaptureAt > (o.window ?? 1)) {
      return this.finish('failed', 'sync');
    }
    if (sim.time >= o.timeLimit) return this.finish('failed', 'timeout');

    // Everything at rest with no net force and nothing that can change: end the run early
    // instead of making the player watch the clock.
    if (this.canStall) {
      let moving = false;
      for (const b of sim.bodies) {
        if (b.active && (b.vx * b.vx + b.vy * b.vy > 1 || b.ax * b.ax + b.ay * b.ay > 1)) { moving = true; break; }
      }
      this.stillSteps = moving ? 0 : this.stillSteps + 1;
      if (this.stillSteps > 150) return this.finish('failed', 'stalled');
    }
    return this.state;
  }

  private capture(b: Body, t: TargetState): void {
    b.active = false;
    b.captured = true;
    b.x = t.def.x;
    b.y = t.def.y;
    if (this.firstCaptureAt < 0) this.firstCaptureAt = this.sim.time;
    this.lastCaptureAt = this.sim.time;
    this.events.push({ type: 'capture', x: t.def.x, y: t.def.y, hue: b.def.hue });
  }

  private finish(state: RunState, reason: FailReason | null): RunState {
    this.state = state;
    this.failReason = reason;
    this.finishTime = this.sim.time;
    return state;
  }

  /** Higher is better. Only meaningful for comparing attempts at the same level. */
  fitness(): number {
    const o = this.level.objective;
    if (this.state === 'success') return 1e6 - this.finishTime;
    if (o.type === 'survive') return this.sim.time * 100;
    let f = this.capturedCount * 2000;
    for (const id of o.required) {
      const b = this.sim.bodies.find((x) => x.id === id)!;
      if (b.captured) continue;
      const d = this.minDist.get(id) ?? Infinity;
      f -= Number.isFinite(d) ? d : 1500;
    }
    if (this.failReason === 'hazard') f -= 250;
    if (this.failReason === 'sync') f += 600;
    return f;
  }
}
