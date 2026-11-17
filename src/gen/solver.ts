import { RNG } from '../core/rng';
import { Level } from '../game/level';
import { HeadlessResult, runHeadless } from '../game/runner';
import { Device, DEVICE_LIMITS, DEVICE_TYPES, DeviceType } from '../physics/types';
import { clamp, dist } from './geometry';
import { Route } from './validate';

export interface SolveResult {
  solved: boolean;
  devices: Device[];
  result: HeadlessResult | null;
  trials: number;
}

/**
 * Search-based solver used to prove that a generated level can be completed with the tools
 * the player is given. It never hard-codes a solution: it proposes device layouts from a few
 * physically motivated plans (pull toward the goal, push along the route, random probes),
 * simulates them with the real engine and hill-climbs on the objective's fitness.
 *
 * It is deliberately a mediocre player. If it can finish a level, a human certainly can.
 */
export function solveLevel(level: Level, routes: Route[], seed: number, budget = 260): SolveResult {
  const rng = new RNG(seed);
  const R = DEVICE_LIMITS;
  const cap = level.strengthCap;
  const anchors: { x: number; y: number }[] = [];
  for (const r of routes) for (const p of r.points) anchors.push(p);
  for (const t of level.targets) anchors.push({ x: t.x, y: t.y });
  for (const b of level.bodies) anchors.push({ x: b.x, y: b.y });
  if (level.objective.type === 'survive') {
    for (let i = 0; i < 12; i++) anchors.push({ x: rng.range(150, level.arena.w - 150), y: rng.range(120, level.arena.h - 120) });
  }

  let nextId = 1;
  const make = (type: DeviceType, x: number, y: number, strength: number, range: number, angle = 0, spin: 1 | -1 = 1): Device => ({
    id: nextId++, type,
    x: clamp(x, 10, level.arena.w - 10), y: clamp(y, 10, level.arena.h - 10),
    strength: clamp(strength, R.strength.min, cap), range: clamp(range, R.range.min, R.range.max), angle, spin,
  });

  /** Tracks remaining tool allowance while a plan is being assembled. */
  const allowance = () => {
    const left = { ...level.tools };
    let total = level.maxDevices;
    return {
      take(type: DeviceType): boolean {
        if (total <= 0 || left[type] <= 0) return false;
        left[type]--;
        total--;
        return true;
      },
      any(): DeviceType | null {
        const opts = DEVICE_TYPES.filter((t) => left[t] > 0);
        return total > 0 && opts.length ? rng.pick(opts) : null;
      },
    };
  };

  const planPull = (): Device[] => {
    const a = allowance();
    const out: Device[] = [];
    for (const r of rng.shuffle(routes)) {
      const end = r.points[r.points.length - 1];
      if (a.take('attractor')) {
        out.push(make('attractor', end.x + rng.range(-12, 12), end.y + rng.range(-12, 12), rng.range(120, cap), r.length * rng.range(0.75, 1.25)));
      }
    }
    return out;
  };

  const planRoute = (): Device[] => {
    const a = allowance();
    const out: Device[] = [];
    for (const r of rng.shuffle(routes)) {
      for (let i = 0; i + 1 < r.points.length; i++) {
        const p = r.points[i];
        const q = r.points[i + 1];
        const len = dist(p.x, p.y, q.x, q.y);
        if (len < 30) continue;
        const ang = Math.atan2(q.y - p.y, q.x - p.x);
        const type = a.any();
        if (!type || !a.take(type)) break;
        const s = rng.range(120, cap);
        if (type === 'field') out.push(make('field', (p.x + q.x) / 2, (p.y + q.y) / 2, s, (len / 2) * rng.range(0.8, 1.3), ang + rng.range(-0.15, 0.15)));
        else if (type === 'attractor') out.push(make('attractor', q.x, q.y, s, len * rng.range(0.9, 1.4)));
        else if (type === 'repulsor') {
          const back = rng.range(40, 110);
          out.push(make('repulsor', p.x - Math.cos(ang) * back, p.y - Math.sin(ang) * back, s, back + len * rng.range(0.4, 1)));
        } else out.push(make('vortex', q.x, q.y, s, len * rng.range(0.8, 1.3), 0, rng.sign()));
      }
    }
    return out;
  };

  const planRandom = (): Device[] => {
    const a = allowance();
    const out: Device[] = [];
    const n = rng.int(1, level.maxDevices);
    for (let i = 0; i < n; i++) {
      const type = a.any();
      if (!type || !a.take(type)) break;
      const p = rng.pick(anchors);
      const aim = rng.pick(anchors);
      out.push(make(type, p.x + rng.range(-70, 70), p.y + rng.range(-70, 70), rng.range(R.strength.min, cap), rng.range(R.range.min, R.range.max),
        rng.chance(0.6) ? Math.atan2(aim.y - p.y, aim.x - p.x) : rng.range(-Math.PI, Math.PI), rng.sign()));
    }
    return out;
  };

  const mutate = (base: Device[]): Device[] => {
    const out = base.map((d) => ({ ...d }));
    const pos = rng.range(8, 60);
    for (const d of out) {
      if (rng.chance(0.6)) { d.x = clamp(d.x + rng.range(-pos, pos), 10, level.arena.w - 10); d.y = clamp(d.y + rng.range(-pos, pos), 10, level.arena.h - 10); }
      if (rng.chance(0.5)) d.strength = clamp(d.strength * rng.range(0.7, 1.35), R.strength.min, cap);
      if (rng.chance(0.4)) d.range = clamp(d.range * rng.range(0.8, 1.25), R.range.min, R.range.max);
      if (d.type === 'field' && rng.chance(0.5)) d.angle += rng.range(-0.4, 0.4);
      if (d.type === 'vortex' && rng.chance(0.15)) d.spin = d.spin === 1 ? -1 : 1;
    }
    if (out.length > 1 && rng.chance(0.1)) out.splice(rng.int(0, out.length - 1), 1);
    return out;
  };

  let best: Device[] = [];
  let bestRes: HeadlessResult | null = null;
  const plans = [planPull, planRoute, planRoute, planRandom, planRandom];
  for (let trial = 1; trial <= budget; trial++) {
    const devices = bestRes && best.length && rng.chance(0.55) ? mutate(best) : rng.pick(plans)();
    if (devices.length === 0) continue;
    const res = runHeadless(level, devices);
    if (!bestRes || res.fitness > bestRes.fitness) {
      best = devices;
      bestRes = res;
      if (res.state === 'success') return { solved: true, devices, result: res, trials: trial };
    }
  }
  return { solved: false, devices: best, result: bestRes, trials: budget };
}
