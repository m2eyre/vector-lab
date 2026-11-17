import { Device, DEVICE_LIMITS, DEVICE_TYPES, DeviceType, DT } from '../physics/types';
import { Level } from './level';
import { runHeadless } from './runner';
import { computeScore, ScoreBreakdown } from './scoring';

/**
 * Solution verification shared by the server (score submissions) and the client (replays).
 * A submitted solution is only a list of devices. It is checked against the level's rules
 * and then the level is re-simulated at the fixed timestep; the score comes from that run,
 * never from a number the client sent.
 */
export const SIM_CONFIG = { dt: DT, integrator: 'semi-implicit-euler', engine: 1 } as const;

export function sanitizeDevices(level: Level, raw: unknown): { ok: true; devices: Device[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, errors: ['devices must be an array'] };
  if (raw.length < 1) errors.push('a solution needs at least one generator');
  if (raw.length > level.maxDevices) errors.push(`too many generators: ${raw.length} placed, ${level.maxDevices} allowed`);
  if (raw.length > 16) return { ok: false, errors };
  const used: Record<string, number> = {};
  const devices: Device[] = [];
  const L = DEVICE_LIMITS;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  raw.forEach((r, i) => {
    const d = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const type = d.type as DeviceType;
    if (typeof type !== 'string' || !DEVICE_TYPES.includes(type)) { errors.push(`device ${i + 1}: unknown type`); return; }
    used[type] = (used[type] ?? 0) + 1;
    if (!fin(d.x) || !fin(d.y) || d.x < 0 || d.y < 0 || d.x > level.arena.w || d.y > level.arena.h) errors.push(`device ${i + 1}: position outside the arena`);
    if (!fin(d.strength) || d.strength < L.strength.min || d.strength > level.strengthCap) errors.push(`device ${i + 1}: strength outside ${L.strength.min}..${level.strengthCap}`);
    if (!fin(d.range) || d.range < L.range.min || d.range > L.range.max) errors.push(`device ${i + 1}: range outside ${L.range.min}..${L.range.max}`);
    if (!fin(d.angle) || Math.abs(d.angle) > 1000) errors.push(`device ${i + 1}: invalid angle`);
    if (d.spin !== 1 && d.spin !== -1) errors.push(`device ${i + 1}: spin must be 1 or -1`);
    devices.push({ id: i + 1, type, x: d.x as number, y: d.y as number, strength: d.strength as number, range: d.range as number, angle: d.angle as number, spin: d.spin as 1 | -1 });
  });
  for (const t of DEVICE_TYPES) {
    if ((used[t] ?? 0) > (level.tools[t] ?? 0)) errors.push(`too many ${t} generators: ${used[t]} placed, ${level.tools[t] ?? 0} available`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, devices };
}

export interface VerifiedRun {
  devices: Device[];
  time: number;
  energy: number;
  steps: number;
  devicesUsed: number;
  score: ScoreBreakdown;
}

export function verifySolution(level: Level, raw: unknown): { ok: true; run: VerifiedRun } | { ok: false; errors: string[] } {
  const checked = sanitizeDevices(level, raw);
  if (!checked.ok) return checked;
  const result = runHeadless(level, checked.devices);
  if (result.state !== 'success') return { ok: false, errors: [`solution does not complete the challenge (${result.failReason ?? result.state})`] };
  const score = computeScore(level, { time: result.time, devicesUsed: checked.devices.length, energy: result.energy });
  return { ok: true, run: { devices: checked.devices, time: result.time, energy: result.energy, steps: result.steps, devicesUsed: checked.devices.length, score } };
}

/** Canonical text form of a solution, used to detect exact duplicate submissions. */
export function solutionKey(devices: Device[]): string {
  return devices.map((d) => [d.type, d.x, d.y, d.strength, d.range, d.type === 'field' ? d.angle : 0, d.type === 'vortex' ? d.spin : 1].join(',')).join('|');
}
